import { cn } from '@/lib/cn';
import { DefinitionNote } from './definition-note';

/**
 * The headline figures, as one instrument rather than four cards.
 *
 * Four identically weighted boxes say all four numbers matter equally. They do not: the
 * decision this page supports is "how many people am I about to message", so contactable
 * leads and the rest are its context. They share one frame divided by hairlines, because
 * they are readings from the same instrument and are meant to be compared, not collected.
 */
export function StatStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-lg border bg-card
                    divide-y divide-border sm:divide-y-0
                    lg:grid-cols-[1.35fr_1fr_1fr_1fr]
                    [&>*]:border-border [&>*+*]:border-l-0 sm:[&>*+*]:border-l">
      {children}
    </div>
  );
}

export function StatCard({ label, value, sub, rule, note, lead = false }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  rule?: string;
  note?: string;
  /** The figure this page exists to answer. Exactly one per strip. */
  lead?: boolean;
}) {
  return (
    <div className={cn('min-w-0 px-4 py-4 sm:px-5', lead && 'bg-brand/[0.04]')}>
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[13px] text-muted-foreground">{label}</span>
        {rule && <DefinitionNote rule={rule} note={note} />}
      </div>
      <div className={cn('figure mt-1.5 leading-none',
        lead ? 'text-brand text-[2rem] sm:text-[2.5rem]' : 'text-[1.5rem] sm:text-[1.75rem]')}>
        {value}
      </div>
      {sub && <div className="mt-2 text-xs leading-snug text-muted-foreground">{sub}</div>}
    </div>
  );
}
