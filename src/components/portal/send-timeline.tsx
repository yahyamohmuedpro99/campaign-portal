import { Fragment } from 'react';

const LABELS: Record<string, string> = {
  approval_created: 'Send approved',
  approval_returned_existing: 'Confirm pressed again; the existing send was returned rather than a second one created',
  lease_acquired: 'A dispatcher took charge of this send',
  provider_request_started: 'Batch handed to the provider',
  provider_response: 'Provider answered',
  chunk_indeterminate: 'A batch was called and never answered; flagged for a decision',
  owner_resolved_indeterminate: 'Owner resolved the unanswered batch',
  poll_page_ingested: 'Delivery reports collected',
  send_completed: 'Send finished',
  send_cancelled: 'Send cancelled',
};

/**
 * The send's own account of itself, straight from the append-only log the dispatcher
 * writes. This is where "what happened after the button was pressed" is answered.
 */
export function SendTimeline({ events, timezone }: {
  events: { id: number; at: string; actor: string; event: string; detail: Record<string, unknown> | null }[];
  timezone: string;
}) {
  const time = new Intl.DateTimeFormat('en-GB',
    { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone });

  if (events.length === 0) {
    return <div className="rounded-xl border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
      Nothing recorded yet.
    </div>;
  }

  return (
    <ol className="overflow-hidden rounded-xl border bg-card text-sm">
      {events.map((e) => (
        <li key={e.id} className="border-b px-4 py-2.5 last:border-b-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{LABELS[e.event] ?? e.event.replace(/_/g, ' ')}</span>
            <span className="tabular text-xs text-muted-foreground">{time.format(new Date(e.at))}</span>
          </div>
          {e.detail && (
            <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              {Object.entries(e.detail)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([k, v]) => (
                  <Fragment key={k}>
                    <div><span className="opacity-70">{k.replace(/_/g, ' ')}:</span>{' '}
                      <span className="tabular">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                    </div>
                  </Fragment>
                ))}
            </dl>
          )}
          <div className="mt-0.5 text-[11px] text-muted-foreground/70">
            {e.actor.startsWith('user:') ? 'by an owner' : e.actor === 'cron' ? 'by the scheduled poller' : 'by the system'}
          </div>
        </li>
      ))}
    </ol>
  );
}
