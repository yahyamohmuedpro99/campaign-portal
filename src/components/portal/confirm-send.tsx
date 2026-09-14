'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { approveSend, type ApproveState } from '@/app/(portal)/b/[slug]/campaigns/[id]/send/actions';
import { AlertCircle, Loader2, Send } from 'lucide-react';

/**
 * The confirmation step.
 *
 * Typing the count rather than clicking through is deliberate: the number is the thing
 * being approved, and it is what the database checks before a single message leaves. If
 * the audience moved while the page was open, the send is refused rather than adjusted.
 */
export function ConfirmSend({ slug, campaignId, previewId, count, channel }: {
  slug: string; campaignId: string; previewId: string; count: number; channel: string;
}) {
  const [state, action, pending] = useActionState<ApproveState, FormData>(approveSend, {});

  return (
    <form action={action} className="rounded-xl border bg-card p-4">
      <input type="hidden" name="previewId" value={previewId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="expectedCount" value={count} />

      <h2 className="text-sm font-medium">Confirm this send</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Real money and real inboxes are on the other side of this button.
      </p>

      {state.error && (
        <Alert variant="destructive" className="mt-3">
          <AlertCircle className="size-4" />
          <AlertDescription>
            {state.error}
            {state.newCount != null && (
              <Link href={`/b/${slug}/campaigns/${campaignId}/send`} className="mt-1 block underline">
                Review the new audience of {state.newCount.toLocaleString()}
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 space-y-1.5">
        <Label htmlFor="confirmCount">
          Type <span className="tabular font-semibold">{count.toLocaleString()}</span> to confirm
        </Label>
        <Input id="confirmCount" name="confirmCount" inputMode="numeric" autoComplete="off"
               placeholder={String(count)} disabled={pending || count === 0} />
      </div>

      <Button type="submit" className="mt-3 w-full gap-2" disabled={pending || count === 0}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        Send to {count.toLocaleString()} by {channel}
      </Button>

      {count === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          No one in this brand currently qualifies for this campaign, so there is nothing to send.
        </p>
      )}

      <Button asChild variant="ghost" size="sm" className="mt-1 w-full">
        <Link href={`/b/${slug}/campaigns/${campaignId}`}>Cancel</Link>
      </Button>
    </form>
  );
}
