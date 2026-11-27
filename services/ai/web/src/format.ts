/** Formatting and aggregation for the portal's tables. Pure. */
import type { UsageDay } from "./api.ts";

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

export interface Totals {
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

const empty = (): Totals => ({ requests: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0 });

function add(into: Totals, row: Totals): Totals {
  into.requests += row.requests;
  into.promptTokens += row.promptTokens;
  into.cachedTokens += row.cachedTokens;
  into.outputTokens += row.outputTokens;
  return into;
}

/** Rows summed per key, in descending key order (newest day first). */
export function byDay(rows: UsageDay[]): [string, Totals][] {
  const days = new Map<string, Totals>();
  for (const row of rows) days.set(row.day, add(days.get(row.day) ?? empty(), row));
  return [...days].sort(([a], [b]) => b.localeCompare(a));
}

/** Rows summed per user, largest output first. */
export function byUser(rows: UsageDay[]): [string, Totals][] {
  const users = new Map<string, Totals>();
  for (const row of rows) users.set(row.sub, add(users.get(row.sub) ?? empty(), row));
  return [...users].sort(([, a], [, b]) => b.outputTokens - a.outputTokens);
}

export function total(rows: UsageDay[]): Totals {
  return rows.reduce(add, empty());
}
