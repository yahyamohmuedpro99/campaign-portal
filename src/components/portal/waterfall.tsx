import Link from 'next/link';
import { cn } from '@/lib/cn';

export type WaterfallStep = {
  step_key: string; label: string; excluded: number; remaining: number;
};

/**
 * Contactability shown as a subtraction rather than a single figure.
 *
 * It is the number in this portal most likely to be quietly wrong: it depends on eight
 * conditions drawn from five places, and the two sources disagree by design. Not one of
 * the thousands of contacts carrying an unsubscribe event has a status of "unsubscribed"
 * in the export. Showing the arithmetic lets a reader challenge one rule instead of
 * doubting the whole number.
 */
export function Waterfall({ steps, hrefFor }: {
  steps: WaterfallStep[];
  hrefFor?: (key: string) => string | undefined;
}) {
  const total = steps.find((s) => s.step_key === 'total');
  const final = steps.find((s) => s.step_key === 'contactable');
  const middle = steps.filter((s) => s.step_key !== 'total' && s.step_key !== 'contactable');
  const max = Math.max(1, ...middle.map((s) => s.excluded));

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
      <Row label={total?.label ?? 'Customers on record'} value={total?.remaining ?? 0} bold />
      <div className="divide-y">
        {middle.map((s) => {
          const href = hrefFor?.(s.step_key);
          const body = (
            <div className="flex items-center gap-2 px-3 py-2.5 text-sm sm:gap-3 sm:px-4">
              <span className="tabular w-16 shrink-0 text-right text-destructive sm:w-20">
                {s.excluded > 0 ? `−${s.excluded.toLocaleString()}` : '—'}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.label}</span>
              <span aria-hidden className="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted sm:block">
                <span className="block h-full rounded-full bg-destructive/50"
                      style={{ width: `${Math.round((s.excluded / max) * 100)}%` }} />
              </span>
              <span className="tabular w-16 shrink-0 text-right text-xs text-muted-foreground sm:w-24">
                {s.remaining.toLocaleString()}
              </span>
            </div>
          );
          return href
            ? <Link key={s.step_key} href={href} className="block transition-colors hover:bg-accent/50">{body}</Link>
            : <div key={s.step_key} className={cn(s.excluded === 0 && 'opacity-55')}>{body}</div>;
        })}
      </div>
      <Row label={final?.label ?? 'Contactable today'} value={final?.remaining ?? 0} bold highlight />
    </div>
  );
}

function Row({ label, value, bold, highlight }: {
  label: string; value: number; bold?: boolean; highlight?: boolean;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-4 py-3',
      highlight ? 'bg-primary/5 border-t' : 'border-b bg-muted/30')}>
      <span className={cn('text-sm', bold && 'font-medium')}>{label}</span>
      <span className={cn('tabular text-base tracking-tight', bold && 'font-semibold',
        highlight && 'text-primary')}>{value.toLocaleString()}</span>
    </div>
  );
}
