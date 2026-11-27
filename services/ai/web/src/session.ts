/** The signed-in member and the admin scope, shared by the shell and every page. */
import { queryOptions, useQuery } from "@tanstack/react-query";

import { api, type Me, type Range, type Scope } from "./api.ts";

export const meQuery = queryOptions({ queryKey: ["me"], queryFn: api.me });

/** The signed-in member. Only valid below the root, which renders nothing until it loads. */
export function useMe(): Me {
  return useQuery(meQuery).data!;
}

export const RANGES = ["1h", "24h", "7d", "30d"] as const satisfies readonly Range[];

/** The admin scope in the URL: `scope=all` for everyone, `user=<sub>` for one member. */
export interface ScopeSearch {
  scope?: "all";
  user?: string;
}

export function toScope(search: ScopeSearch, me: Me): Scope {
  if (me.role !== "admin") return {};
  if (search.user) return { sub: search.user };
  return search.scope === "all" ? { all: true } : {};
}
