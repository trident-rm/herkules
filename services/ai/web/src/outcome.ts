import type { RequestRow } from "./api.ts";

export type Outcome = "ok" | "error" | "cancelled";

/** The same three outcomes as the server's `status` filter. */
export function outcome(r: Pick<RequestRow, "status" | "error" | "cancelled">): Outcome {
  if (r.cancelled) return "cancelled";
  return r.status >= 400 || r.error ? "error" : "ok";
}
