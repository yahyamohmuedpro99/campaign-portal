'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { createShare, revokeShare } from '@/lib/share/actions';
import { Copy, Link2, Loader2, ShieldCheck } from 'lucide-react';

type ShareRow = {
  id: string; label: string | null; created_at: string; expires_at: string;
  revoked_at: string | null; view_count: number; last_viewed_at: string | null;
};

export function ShareManager({ slug, campaignId, campaignName, isOwner, hasSend, shares, timezone }: {
  slug: string; campaignId: string; campaignName: string;
  isOwner: boolean; hasSend: boolean; shares: ShareRow[]; timezone: string;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<{ url: string; password: string } | null>(null);

  const when = (s: string) => new Intl.DateTimeFormat('en-GB',
    { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(s));

  async function submit() {
    setPending(true);
    const res = await createShare(campaignId, slug, label.trim() || null, password);
    setPending(false);
    if (!res.ok) { toast.error(res.error); return; }
    setCreated({ url: res.url, password: res.password });
    toast.success('Link created. Copy it now: the password is not shown again.');
  }

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Share these results</h2>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            A link a client can open without an account. It shows this campaign’s totals and
            nothing else: no customer records, no other campaign, no way into the portal.
          </p>
        </div>
        {isOwner && (
          <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setCreated(null); setPassword(''); setLabel(''); } }}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 whitespace-nowrap" disabled={!hasSend}>
                <Link2 className="size-4" />Create link
              </Button>
            </DialogTrigger>
            <DialogContent>
              {created ? (
                <>
                  <DialogHeader>
                    <DialogTitle>Link created</DialogTitle>
                    <DialogDescription>
                      Copy both now. The password is hashed on save and cannot be shown again.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <Field label="Link" value={created.url} onCopy={() => copy(created.url, 'Link')} />
                    <Field label="Password" value={created.password} onCopy={() => copy(created.password, 'Password')} />
                  </div>
                  <DialogFooter>
                    <Button onClick={() => { setOpen(false); setCreated(null); }}>Done</Button>
                  </DialogFooter>
                </>
              ) : (
                <>
                  <DialogHeader>
                    <DialogTitle>Publish “{campaignName}” results</DialogTitle>
                    <DialogDescription>
                      Anyone with the link and the password can see this campaign’s totals.
                      The link expires in 30 days and you can revoke it at any time.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="share-label">Who is this for (optional)</Label>
                      <Input id="share-label" value={label} onChange={(e) => setLabel(e.target.value)}
                             placeholder="e.g. monthly client review" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="share-password">Password</Label>
                      <Input id="share-password" type="text" value={password}
                             onChange={(e) => setPassword(e.target.value)}
                             placeholder="At least 8 characters" />
                      <p className="text-xs text-muted-foreground">
                        Send it separately from the link, not in the same message.
                      </p>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={submit} disabled={pending || password.length < 8}>
                      {pending && <Loader2 className="size-4 animate-spin" />}Create link
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        )}
      </div>

      {!hasSend && isOwner && (
        <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          There is nothing to publish yet. Send this campaign first, and its results become
          shareable.
        </p>
      )}

      {shares.length > 0 && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="border-b bg-muted/40 text-left">
              <th className="px-4 py-2 font-medium">Label</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Expires</th>
              <th className="px-3 py-2 text-right font-medium">Views</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2" />
            </tr></thead>
            <tbody className="divide-y">
              {shares.map((s) => {
                const expired = new Date(s.expires_at) < new Date();
                return (
                  <tr key={s.id}>
                    <td className="px-4 py-2">{s.label ?? <span className="text-muted-foreground">Untitled</span>}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{when(s.created_at)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{when(s.expires_at)}</td>
                    <td className="tabular px-3 py-2 text-right">{s.view_count}</td>
                    <td className="px-3 py-2">
                      {s.revoked_at ? <Badge variant="secondary">Revoked</Badge>
                        : expired ? <Badge variant="secondary">Expired</Badge>
                        : <Badge className="gap-1 bg-success/15 text-success hover:bg-success/15">
                            <ShieldCheck className="size-3" />Live
                          </Badge>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isOwner && !s.revoked_at && !expired && (
                        <Button size="sm" variant="ghost" className="text-destructive"
                                onClick={async () => {
                                  const r = await revokeShare(s.id, slug, campaignId);
                                  if (r.ok) toast.success('Link revoked');
                                  else toast.error(r.error);
                                }}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Field({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button variant="outline" size="icon" onClick={onCopy} aria-label={`Copy ${label}`}>
          <Copy className="size-4" />
        </Button>
      </div>
    </div>
  );
}
