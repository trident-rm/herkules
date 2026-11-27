import { cn } from "@herkules/ui/lib/utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { api, type Stats, type Totals } from "../api.ts";
import { TimeChart } from "../charts.tsx";
import { count, fixed, ms, percent, shortRoute, stamp } from "../format.ts";
import { ScopeSwitch } from "../scope.tsx";
import { RANGES, toScope, useMe } from "../session.ts";
import { ErrorText, Muted, PageHeader, Panel, Segmented, StatusPill } from "../ui.tsx";
import { BackendCards } from "./Models.tsx";

export function OverviewPage() {
  const me = useMe();
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const range = search.range ?? "24h";
  const scope = toScope(search, me);
  const stats = useQuery({
    queryKey: ["stats", range, scope],
    queryFn: () => api.stats(range, scope),
    placeholderData: keepPreviousData,
    refetchInterval: range === "1h" ? 15_000 : 60_000,
  });
  const people = Object.fromEntries(
    (stats.data?.users ?? []).map((u) => [
      u.sub,
      { displayName: u.displayName ?? u.sub, avatarUrl: u.avatarUrl },
    ]),
  );

  return (
    <>
      <PageHeader title="Overview">
        <ScopeSwitch
          search={search}
          people={people}
          onChange={(next) => void navigate({ search: (s) => ({ ...s, ...next }) })}
        />
        <Segmented
          label="Time range"
          value={range}
          options={RANGES.map((r) => ({ value: r, label: r }))}
          onChange={(r) => void navigate({ search: (s) => ({ ...s, range: r }) })}
        />
      </PageHeader>
      <ErrorText error={stats.error} />
      {stats.data ? (
        <Dashboard stats={stats.data} everyone={!!scope.all} />
      ) : (
        !stats.error && <Muted>Loading…</Muted>
      )}
      <Panel title="Backends" className="mt-4" action={<Link to="/models">Models</Link>}>
        <BackendCards />
      </Panel>
    </>
  );
}

function Dashboard({ stats, everyone }: { stats: Stats; everyone: boolean }) {
  const { totals: t, bucketSeconds } = stats;
  const series = stats.series.map((p) => ({
    t: p.t,
    ok: p.requests - p.errors - p.cancelled,
    errors: p.errors,
    cancelled: p.cancelled,
    prompt: p.promptTokens - p.cachedTokens,
    cached: p.cachedTokens,
    output: p.outputTokens,
    errorRate: p.requests ? (p.errors / p.requests) * 100 : null,
    ttftP50: p.ttftP50,
    ttftP95: p.ttftP95,
    tpsP50: p.tpsP50,
    tpsP95: p.tpsP95,
  }));

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Requests" value={count(t.requests)} />
        <Stat
          label="Error rate"
          value={percent(t.errors, t.requests)}
          sub={`${count(t.errors)} failed · ${count(t.cancelled)} cancelled`}
          tone={t.errors > 0 ? "danger" : undefined}
        />
        <Stat
          label="Prompt tokens"
          value={count(t.promptTokens)}
          sub={`${percent(t.cachedTokens, t.promptTokens)} cached`}
        />
        <Stat label="Output tokens" value={count(t.outputTokens)} />
        <Stat label="TTFT p50" value={ms(t.ttftP50)} sub={`p95 ${ms(t.ttftP95)}`} />
        <Stat
          label="Decode p50"
          value={`${fixed(t.tpsP50)} tok/s`}
          sub={`p95 ${fixed(t.tpsP95)}`}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Requests">
          <TimeChart
            kind="bars"
            data={series}
            bucketSeconds={bucketSeconds}
            format={count}
            series={[
              { key: "ok", label: "Succeeded", color: "var(--series-1)" },
              { key: "errors", label: "Failed", color: "var(--series-critical)" },
              { key: "cancelled", label: "Cancelled", color: "var(--series-neutral)" },
            ]}
          />
        </Panel>
        <Panel title="Tokens">
          <TimeChart
            kind="areas"
            data={series}
            bucketSeconds={bucketSeconds}
            format={count}
            series={[
              { key: "prompt", label: "Prompt, uncached", color: "var(--series-1)" },
              { key: "cached", label: "Prompt, cached", color: "var(--series-3)" },
              { key: "output", label: "Output", color: "var(--series-2)" },
            ]}
          />
        </Panel>
        <Panel title="Time to first token">
          <TimeChart
            kind="lines"
            data={series}
            bucketSeconds={bucketSeconds}
            format={ms}
            series={[
              { key: "ttftP50", label: "p50", color: "var(--series-1)" },
              { key: "ttftP95", label: "p95", color: "var(--series-1)", dashed: true },
            ]}
          />
        </Panel>
        <Panel title="Decode speed, tok/s">
          <TimeChart
            kind="lines"
            data={series}
            bucketSeconds={bucketSeconds}
            format={(n) => fixed(n, 0)}
            series={[
              { key: "tpsP50", label: "p50", color: "var(--series-2)" },
              { key: "tpsP95", label: "p95", color: "var(--series-2)", dashed: true },
            ]}
          />
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel title="By model" bodyClassName="p-0">
          <Breakdown
            rows={stats.models.map((m) => ({
              id: m.model ?? "",
              label: m.model ?? "no model",
              link: { model: m.model ?? undefined },
              totals: m,
            }))}
          />
        </Panel>
        <Panel
          title="Recent failures"
          bodyClassName="p-0"
          action={
            <Link to="/logs" search={(s) => ({ scope: s.scope, user: s.user, status: "error" })}>
              All
            </Link>
          }
        >
          {stats.recentErrors.length === 0 ? (
            <Muted className="px-4">No failures in this range.</Muted>
          ) : (
            <ul className="m-0 list-none divide-y divide-line-2 p-0">
              {stats.recentErrors.map((r) => (
                <li key={r.id}>
                  <Link
                    to="/logs"
                    search={(s) => ({ scope: s.scope, user: s.user, status: "error", id: r.id })}
                    className="flex items-center gap-3 px-4 py-2 text-foreground hover:bg-surface-2"
                  >
                    <StatusPill row={r} />
                    <span className="w-28 shrink-0 text-xs text-muted-foreground">
                      {stamp(r.at)}
                    </span>
                    <span className="w-40 shrink-0 truncate text-xs">
                      {r.model ?? shortRoute(r.route)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {r.error ?? `HTTP ${r.status}`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {everyone ? (
          <Panel title="Top members" bodyClassName="p-0">
            <Breakdown
              rows={stats.users.map((u) => ({
                id: u.sub,
                label: u.displayName ?? u.sub.slice(0, 12),
                link: { user: u.sub },
                totals: u,
              }))}
            />
          </Panel>
        ) : (
          <Panel title="By key" bodyClassName="p-0">
            <Breakdown
              rows={stats.keys.map((k) => ({
                id: String(k.keyId),
                label: k.keyName ?? `key ${k.keyId}`,
                link: { key: k.keyId },
                totals: k,
              }))}
            />
          </Panel>
        )}
        <Panel title="By backend" bodyClassName="p-0">
          <Breakdown
            rows={stats.backends.map((b) => ({
              id: b.backend ?? "",
              label: b.backend ?? "none",
              link: { backend: b.backend ?? undefined },
              totals: b,
            }))}
          />
        </Panel>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "danger";
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tracking-tight",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

interface BreakdownRow {
  id: string;
  label: string;
  /** Log filters that show this row's requests. */
  link: { model?: string; backend?: string; key?: number; user?: string };
  totals: Totals;
}

function Breakdown({ rows }: { rows: BreakdownRow[] }) {
  if (rows.length === 0) return <Muted className="px-4">No requests in this range.</Muted>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line-2 text-left text-xs text-muted-foreground">
          <Th className="pl-4">Name</Th>
          <Th right>Requests</Th>
          <Th right>Failed</Th>
          <Th right>In</Th>
          <Th right>Out</Th>
          <Th right>TTFT p50</Th>
          <Th right className="pr-4">
            tok/s p50
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-line-2 last:border-0 hover:bg-surface-2">
            <td className="max-w-56 truncate py-1.5 pl-4">
              <Link
                to="/logs"
                search={(s) => ({
                  scope: r.link.user ? undefined : s.scope,
                  user: r.link.user ?? s.user,
                  model: r.link.model,
                  backend: r.link.backend,
                  key: r.link.key,
                })}
                className="text-foreground hover:text-primary"
              >
                {r.label}
              </Link>
            </td>
            <Td>{count(r.totals.requests)}</Td>
            <Td className={r.totals.errors > 0 ? "text-danger" : undefined}>
              {percent(r.totals.errors, r.totals.requests)}
            </Td>
            <Td>{count(r.totals.promptTokens)}</Td>
            <Td>{count(r.totals.outputTokens)}</Td>
            <Td>{ms(r.totals.ttftP50)}</Td>
            <Td className="pr-4">{fixed(r.totals.tpsP50)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <th className={cn("px-2 py-2 font-medium", right && "text-right", className)}>{children}</th>
  );
}
function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("px-2 py-1.5 text-right whitespace-nowrap", className)}>{children}</td>;
}
