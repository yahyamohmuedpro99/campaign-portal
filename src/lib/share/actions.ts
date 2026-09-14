'use server';

import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { createClient } from '@/lib/supabase/server';
import { newShareToken, tokenHashHex } from './tokens';

export type CreateShareResult =
  | { ok: true; url: string; password: string }
  | { ok: false; error: string };

/**
 * Mints a shareable link for one campaign's results.
 *
 * The token and the password are generated here and shown to the owner exactly once. The
 * database keeps only a SHA-256 of the token and a bcrypt hash of the password, and
 * neither column can be selected by any signed-in role, so nothing stored can be turned
 * back into a working link.
 */
export async function createShare(
  campaignId: string, slug: string, label: string | null, password: string,
): Promise<CreateShareResult> {
  if (!password || password.length < 8) {
    return { ok: false, error: 'Choose a password of at least 8 characters.' };
  }

  const token = newShareToken();
  const supabase = await createClient();
  const { error } = await supabase.rpc('create_campaign_share', {
    p_campaign_id: campaignId,
    p_token_hash: tokenHashHex(token),
    p_password_hash: await bcrypt.hash(password, 12),
    p_label: label,
    p_expires_in_days: 30,
  });

  if (error) {
    return { ok: false, error: error.message.includes('forbidden')
      ? 'Only an owner of this brand can publish results.' : error.message };
  }

  revalidatePath(`/b/${slug}/campaigns/${campaignId}`);
  const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
  return { ok: true, url: `${base}/share/${token}`, password };
}

export async function revokeShare(shareId: string, slug: string, campaignId: string) {
  const supabase = await createClient();
  const { error } = await supabase.rpc('revoke_campaign_share', { p_share_id: shareId });
  revalidatePath(`/b/${slug}/campaigns/${campaignId}`);
  return error ? { ok: false, error: error.message } : { ok: true as const };
}
