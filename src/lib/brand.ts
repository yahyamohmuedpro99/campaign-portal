import { notFound, redirect } from 'next/navigation';
import { createClient, getUser } from '@/lib/supabase/server';

export type Membership = {
  brandId: string;
  slug: string;
  code: string;
  name: string;
  country: string;
  timezone: string;
  role: 'owner' | 'analyst';
};

/**
 * Resolves the brand in the URL for the signed-in user.
 *
 * This decides what the interface offers, not what the data layer permits. Someone who
 * defeats it still cannot read another brand's rows, because every query underneath is
 * filtered by a row-level security policy keyed to their own membership.
 */
export async function requireMembership(slug: string): Promise<Membership> {
  const user = await getUser();
  if (!user) redirect('/login');

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('brand_members')
    .select('role, brand_id, brands!inner(id, slug, code, name, country, timezone)')
    .eq('brands.slug', slug)
    .maybeSingle();

  if (error || !data) notFound();
  const b = data.brands as unknown as {
    id: string; slug: string; code: string; name: string; country: string; timezone: string;
  };
  return {
    brandId: b.id, slug: b.slug, code: b.code, name: b.name,
    country: b.country, timezone: b.timezone,
    role: data.role as 'owner' | 'analyst',
  };
}

/** Every brand this user belongs to. Used to route them after signing in. */
export async function myBrands() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('brand_members')
    .select('role, brands!inner(id, slug, code, name, country, timezone)');
  return (data ?? []).map((m) => {
    const b = m.brands as unknown as {
      id: string; slug: string; code: string; name: string; country: string; timezone: string;
    };
    return { ...b, brandId: b.id, role: m.role as 'owner' | 'analyst' };
  });
}
