// Module-level singletons — constructing Intl formatters per call is
// expensive, and these render in every table row. Options mirror the
// defaults of toLocaleString() so output stays identical.
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});
const numberFormatter = new Intl.NumberFormat();
// Date-only, same output as toLocaleDateString(). Seven warehouse table cells
// called that directly, each building a fresh Intl.DateTimeFormat per cell per
// render — the singleton above existed but was routed around.
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

export function formatDateTime(value?: string | number | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return dateTimeFormatter.format(date);
}

/**
 * Relative time like "3 weeks ago" / "2 hours ago" / "just now".
 * Falls back to the empty string when value is missing so callers can show
 * a semantic placeholder ("Never sent") rather than a literal "—".
 */
export function formatDate(value?: string | number | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return dateFormatter.format(date);
}

export function formatRelative(value?: string | number | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 0) {
    return formatRelativeFuture(-diffSec);
  }
  if (diffSec < 45) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  const diffWk = Math.round(diffDay / 7);
  if (diffWk < 5) return `${diffWk} week${diffWk === 1 ? "" : "s"} ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo} month${diffMo === 1 ? "" : "s"} ago`;
  const diffYr = Math.round(diffDay / 365);
  return `${diffYr} year${diffYr === 1 ? "" : "s"} ago`;
}

function formatRelativeFuture(diffSec: number): string {
  if (diffSec < 60) return "in a few seconds";
  const m = Math.round(diffSec / 60);
  if (m < 60) return `in ${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

/** Drop-in helper for the common "1 thing" / "2 things" pattern. */
export function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural || singular + "s"}`;
}

export function formatNumber(value?: number | null) {
  return numberFormatter.format(value || 0);
}

export function formatPercent(value?: number | null) {
  return `${value || 0}%`;
}

export function humanize(value?: string | null) {
  if (!value) return "—";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function extractEmail(value?: string | null) {
  if (!value) return "";
  const match = value.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return match ? match[0] : value;
}

// ──────────── AI Agents: money / tokens / latency ────────────
// One agent run costs $0.0042; a month of the personalizer costs $412. A
// single fixed precision cannot show both, so precision scales with
// magnitude — four decimals below a cent, cents below a thousand, whole
// dollars with separators above it.
const usdWholeFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const usdCentsFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsd(value?: number | null): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs === 0) return "$0.00";
  // Below the 4dp floor, "$0.0000" reads as free when it is not.
  if (abs < 0.00005) return `${sign}<$0.0001`;
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  if (abs < 1000) return `${sign}$${usdCentsFormatter.format(abs)}`;
  return `${sign}$${usdWholeFormatter.format(Math.round(abs))}`;
}

/** 940 / 1.2k / 3.40M / 1.05B. Token counts are estimates anyway — past a
 * thousand the exact digits are noise, so they get traded for scannability. */
export function formatTokens(value?: number | null): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1_000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  if (abs < 1_000_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
}

/** 450ms / 1.4s / 2m 05s. */
export function formatMs(value?: number | null): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (n < 1_000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
