"use client";

import { cn } from "@/lib/cn";

/**
 * One horizontal bar in a ranked list.
 *
 * Colour discipline (Iris on Carbon): a ranked list is already encoding
 * magnitude through length and order, so every bar is the same
 * `bg-primary/70`. Inventing a categorical hue per row would add a second,
 * redundant encoding and burn the semantic colours we need for failures.
 * `tone` exists only for the lists that ARE about failure.
 */

export type BarTone = "primary" | "danger" | "warning" | "success" | "muted";

const TONE_CLASS: Record<BarTone, string> = {
  primary: "bg-primary/70",
  danger: "bg-danger-fill",
  warning: "bg-warning-fill",
  success: "bg-success-fill",
  muted: "bg-muted-foreground/40",
};

export function BarRow({
  label,
  value,
  max,
  display,
  secondary,
  tone = "primary",
  title,
  labelClassName,
  onClick,
}: {
  label: React.ReactNode;
  value: number;
  /** Largest value in the list. A zero/negative max renders an empty track
   * rather than a NaN width — see the note below. */
  max: number;
  /** Formatted value shown on the right. */
  display: React.ReactNode;
  /** Optional dimmer second column (e.g. run count next to a cost). */
  secondary?: React.ReactNode;
  tone?: BarTone;
  title?: string;
  labelClassName?: string;
  onClick?: () => void;
}) {
  // A NaN or Infinity width is not rendered by React at all, which drops the
  // style attribute and lets the bar inherit the track's full width — a
  // silent "100%" lie. Clamp to a real number before it reaches the DOM.
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const ratio = safeMax > 0 && Number.isFinite(value) ? value / safeMax : 0;
  const pct = Math.max(0, Math.min(100, ratio * 100));

  const body = (
    <>
      <span
        className={cn("w-32 shrink-0 truncate text-muted-foreground", labelClassName)}
        title={typeof label === "string" ? label : undefined}
      >
        {label}
      </span>
      <span className="relative h-3 flex-1 overflow-hidden rounded bg-muted/40">
        <span
          className={cn("absolute inset-y-0 left-0 rounded", TONE_CLASS[tone])}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-20 shrink-0 text-right tabular-nums">{display}</span>
      {secondary !== undefined ? (
        <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
          {secondary}
        </span>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className="flex w-full items-center gap-3 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-muted/40"
      >
        {body}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3 px-1 text-xs" title={title}>
      {body}
    </div>
  );
}

/** Shared zero-state copy. A list of zero-height bars looks like a rendering
 * bug; a sentence does not. */
export function ChartEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm italic text-muted-foreground">{children}</p>;
}
