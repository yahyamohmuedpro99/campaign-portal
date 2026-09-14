import Link from 'next/link';
import { requireMembership } from '@/lib/brand';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/portal/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EXCLUSION_LABELS, DEFINITIONS } from '@/lib/definitions';
import { DefinitionNote } from '@/components/portal/definition-note';
import { ContactSearch } from '@/components/portal/contact-search';
import { ChevronRight, Inbox } from 'lucide-react';

const PAGE_SIZE = 50;

export default async function ContactsPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ exclusion?: string; q?: string; cursor?: string }>;
}) {
  const { slug } = await params;
  const { exclusion, q, cursor } = await searchParams;
  const brand = await requireMembership(slug);
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('brand_contacts_page', {
    p_brand_id: brand.brandId,
    p_exclusion: exclusion ?? null,
    p_search: q ?? null,
    p_cursor: cursor ?? null,
    p_limit: PAGE_SIZE,
  });

  const rows = (data ?? []) as ContactRow[];
  const nextCursor = rows.length === PAGE_SIZE ? rows[rows.length - 1].id : null;
  const qs = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { exclusion: exclusion ?? null, q: q ?? null, cursor: cursor ?? null, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/b/${slug}/contacts${s ? `?${s}` : ''}`;
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        description={<>Everyone imported for {brand.name}. Identity is the brand’s own customer
          reference, so a reference reused by another brand is a different person.</>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ContactSearch slug={slug} defaultValue={q ?? ''} exclusion={exclusion} />
        {exclusion && (
          <Badge variant="secondary" className="gap-1.5 py-1">
            {EXCLUSION_LABELS[exclusion] ?? exclusion}
            <Link href={qs({ exclusion: null, cursor: null })} className="hover:text-foreground" aria-label="Clear filter">×</Link>
          </Badge>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
          Contactable
          <DefinitionNote rule={DEFINITIONS.contactable.rule} note={DEFINITIONS.contactable.note} />
        </span>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
          <h2 className="font-semibold">These contacts could not be loaded</h2>
          <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card px-6 py-16 text-center">
          <div className="rounded-full bg-muted p-3"><Inbox className="size-5 text-muted-foreground" /></div>
          <p className="text-sm font-medium">No contacts match</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {q ? <>Nothing matched “{q}”.</> : exclusion
              ? <>No customers fall into “{EXCLUSION_LABELS[exclusion] ?? exclusion}”.</>
              : <>Nothing has been imported for this brand yet.</>}
          </p>
          {(q || exclusion) && (
            <Button asChild variant="outline" size="sm" className="mt-1">
              <Link href={`/b/${slug}/contacts`}>Clear filters</Link>
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left">
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Email</th>
                  <th className="px-3 py-2.5 font-medium">Mobile</th>
                  <th className="px-3 py-2.5 font-medium">Signed up</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((c) => (
                  <tr key={c.id} className="align-top transition-colors hover:bg-accent/40">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{c.full_name ?? <span className="text-muted-foreground">No name</span>}</div>
                      <div className="text-xs text-muted-foreground">
                        {c.external_id}{c.city ? ` · ${c.city}` : ''}{c.country ? ` · ${c.country}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {c.email
                        ? <span>{c.email}</span>
                        : c.email_raw
                          ? <span className="text-muted-foreground line-through decoration-destructive/60" title="Not a usable address; kept as it appeared in the export">
                              {c.email_raw}
                            </span>
                          : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.phone_e164
                        ? <span className="tabular">{c.phone_e164}</span>
                        : c.phone_raw
                          ? <span className="tabular text-muted-foreground line-through decoration-destructive/60" title="Could not be resolved to a real number in any plausible reading">
                              {c.phone_raw}
                            </span>
                          : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {c.signup_at
                        ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: brand.timezone }).format(new Date(c.signup_at))
                        : <span title="No usable signup date in the export">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.contactable
                        ? <Badge className="bg-success/15 text-success hover:bg-success/15">Contactable</Badge>
                        : <Badge variant="secondary" title={EXCLUSION_LABELS[c.exclusion_reason ?? ''] ?? undefined}>
                            {EXCLUSION_LABELS[c.exclusion_reason ?? '']?.replace(/^.*?(Unsubscribed|spam|bounce|consent|active|suppression|usable|Removed).*$/i, (m) => m) ?? 'Not contactable'}
                          </Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Showing {rows.length} contact{rows.length === 1 ? '' : 's'}. Pages are read by
              cursor, so the largest brand opens as quickly as the smallest.
            </p>
            {nextCursor && (
              <Button asChild variant="outline" size="sm">
                <Link href={qs({ cursor: nextCursor })}>Next <ChevronRight className="size-4" /></Link>
              </Button>
            )}
          </div>
        </>
      )}
    </>
  );
}

type ContactRow = {
  id: string; external_id: string; full_name: string | null;
  email: string | null; email_raw: string | null;
  phone_e164: string | null; phone_raw: string | null;
  country: string | null; city: string | null; signup_at: string | null;
  status: string; consent_marketing: boolean | null;
  contactable: boolean; exclusion_reason: string | null;
};
