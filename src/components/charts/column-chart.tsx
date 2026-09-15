"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

import { ChartEmpty, type BarTone } from "./bar-row";

/**
 * Vertical column chart, hand-rolled from divs.
 *
 * There is no charting library in this app and adding one for a time series of
 * at most 90 columns would be the tail wagging the dog. Each column is a
 * flex child with a percentage height, so it reflows with the card and picks
 * up the theme's tokens for free.
 *
 * Every column gets a Radix Tooltip because the x axis can only afford a few
 * labels — the tooltip is where the exact day and value live.
 */

const TONE_CLASS: Record<BarTone, string> = {
  primary: "bg-brand/65 group-hover:bg-brand",
  danger: "bg-danger-fill",
  warning: "bg-warning-fill",
  success: "bg-success-fill",
  muted: "bg-muted-foreground/40",
};

export interface ColumnDatum {
  /** Short axis label, e.g. "08-04". */
  label: string;
  value: number;
  /** Rich tooltip body. Falls back to `label: value`. */
  tooltip?: React.ReactNode;
  /** Per-column override, for marking a day that failed. */
  tone?: BarTone;
}

export function ColumnChart({
  data,
  height = 120,
  tone = "primary",
  emptyLabel = "Nothing recorded in this window yet.",
  maxLabels = 8,
  formatValue,
}: {
  data: ColumnDatum[];
  height?: number;
  tone?: BarTone;
  emptyLabel?: React.ReactNode;
  /** Roughly how many x-axis labels to show; the rest are dropped so 90 days
   * of dates do not turn the axis into a smear. */
  maxLabels?: number;
  formatValue?: (value: number) => string;
}) {
  if (data.length === 0) return <ChartEmpty>{emptyLabel}</ChartEmpty>;

  const max = data.reduce((m, d) => (Number.isFinite(d.value) && d.value > m ? d.value : m), 0);
  // Every value is zero: a row of invisible bars reads as broken, so say so.
  if (max <= 0) return <ChartEmpty>{emptyLabel}</ChartEmpty>;

  const step = Math.max(1, Math.ceil(data.length / maxLabels));

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {data.map((d, i) => {
          const value = Number.isFinite(d.value) ? Math.max(0, d.value) : 0;
          // Floor at 2% so a real-but-tiny value stays visible as a sliver
          // instead of vanishing and reading as "no data".
          const pct = value > 0 ? Math.max(2, (value / max) * 100) : 0;
          return (
            <Tooltip key={`${d.label}-${i}`}>
              <TooltipTrigger asChild>
                <div className="group flex h-full flex-1 cursor-default items-end">
                  <div
                    className={cn(
                      "w-full transition-colors",
                      TONE_CLASS[d.tone ?? tone],
                    )}
                    style={{ height: `${pct}%` }}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {d.tooltip ?? (
                  <span>
                    {d.label} · {formatValue ? formatValue(value) : value}
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <Axis data={data} step={step} />
    </div>
  );
}

/**
 * The axis.
 *
 * Giving every column an equal-width label truncates each one to a single character once
 * there are thirty of them. Beyond a handful of columns only the ends and the middle are
 * labelled, spread across the full width, and the exact day and value live in the tooltip
 * on each column.
 */
function Axis({ data, step }: { data: ColumnDatum[]; step: number }) {
  if (data.length <= 8) {
    return (
      <div className="flex gap-[2px] text-[10px] text-muted-foreground">
        {data.map((d, i) => (
          <span key={`${d.label}-axis-${i}`} className="min-w-0 flex-1 truncate text-center">
            {i % step === 0 ? d.label : "\u00a0"}
          </span>
        ))}
      </div>
    );
  }
  const first = data[0]?.label;
  const middle = data[Math.floor(data.length / 2)]?.label;
  const last = data[data.length - 1]?.label;
  return (
    <div className="flex items-baseline justify-between text-[10px] text-muted-foreground">
      <span className="whitespace-nowrap">{first}</span>
      <span className="whitespace-nowrap">{middle}</span>
      <span className="whitespace-nowrap">{last}</span>
    </div>
  );
}
