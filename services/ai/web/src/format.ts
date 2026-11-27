/** Formatting for the portal's numbers and times. Pure. */

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function fixed(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined ? "–" : n.toFixed(digits);
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}

export function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function percent(part: number, whole: number): string {
  if (whole === 0) return "–";
  const p = (part / whole) * 100;
  return p > 0 && p < 0.1 ? "<0.1%" : `${p.toFixed(p >= 10 ? 0 : 1)}%`;
}

/** A log timestamp: time of day for today, date and time otherwise. */
export function stamp(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** An axis tick for a chart bucket: clock time for short buckets, the date for long ones. */
export function tick(iso: string, bucketSeconds: number): string {
  const at = new Date(iso);
  if (bucketSeconds >= 43_200)
    return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (bucketSeconds < 3600) return time;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** The route without its version prefix: `/v1/chat/completions` → `chat/completions`. */
export function shortRoute(route: string): string {
  return route.replace(/^\/v1\//, "").replace(/^\//, "");
}
