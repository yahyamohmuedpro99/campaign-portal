import { cn } from '@/lib/cn';
import { DefinitionNote } from './definition-note';

export function StatCard({ label, value, sub, rule, note, tone = 'default' }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  rule?: string;
  note?: string;
  tone?: 'default' | 'muted';
}) {
  return (
    <div className={cn('rounded-xl border p-4', tone === 'muted' ? 'bg-muted/30' : 'bg-card')}>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        {rule && <DefinitionNote rule={rule} note={note} />}
      </div>
      <div className="tabular mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
