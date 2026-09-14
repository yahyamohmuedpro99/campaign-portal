'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export type ApproveState = { error?: string; newCount?: number };

/**
 * Turns a preview into an approved send.
 *
 * The count the owner typed is passed back to the database, which recomputes the audience
 * from the same function the preview used and refuses if either the size or the exact
 * membership has moved. Pressing confirm twice, or from two browsers at once, produces one
 * send: the database serialises the callers and hands the loser the send the winner made.
 */
export async function approveSend(_prev: ApproveState, formData: FormData): Promise<ApproveState> {
  const previewId = String(formData.get('previewId') ?? '');
  const slug = String(formData.get('slug') ?? '');
  const expected = Number(formData.get('expectedCount') ?? NaN);
  const typed = String(formData.get('confirmCount') ?? '').replace(/[\s,]/g, '');

  if (!previewId || !slug || !Number.isFinite(expected)) {
    return { error: 'Something went wrong preparing this send. Reload and try again.' };
  }
  if (typed !== String(expected)) {
    return { error: `Type ${expected.toLocaleString()} to confirm you are sending to that many people.` };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('approve_campaign_send', {
    p_preview_id: previewId,
    p_expected_count: expected,
  });

  if (error) {
    if (error.message.includes('audience_count_changed')) {
      const now = error.message.match(/now=(\d+)/)?.[1];
      return {
        error: 'The audience changed while you were reviewing it, so nothing was sent. Check the new list and confirm again.',
        newCount: now ? Number(now) : undefined,
      };
    }
    if (error.message.includes('audience_membership_changed')) {
      return { error: 'The same number of people, but not the same people, so nothing was sent. Review the list again.' };
    }
    if (error.message.includes('forbidden')) {
      return { error: 'Only an owner of this brand can send.' };
    }
    return { error: error.message };
  }

  const send = Array.isArray(data) ? data[0] : data;
  redirect(`/b/${slug}/sends/${send.id}`);
}
