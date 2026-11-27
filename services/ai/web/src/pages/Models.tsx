import { cn } from "@herkules/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { api, type BackendView, type Median } from "../api.ts";
import { count, fixed, ms } from "../format.ts";
import { useMe } from "../session.ts";
import { CopyButton, Dot, ErrorText, Muted, PageHeader, Panel } from "../ui.tsx";

export function usePerformance() {
  return useQuery({ queryKey: ["performance"], queryFn: api.performance, refetchInterval: 10_000 });
}

export function StateBadge({ state }: { state: BackendView["state"] }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-px text-[11px] font-medium",
        state === "enabled" && "bg-ok-soft text-ok",
        state === "draining" && "bg-warn-soft text-warn",
        state === "disabled" && "bg-surface-2 text-muted-foreground",
      )}
    >
      {state}
    </span>
  );
}

/** One card per backend with its live health and load, refreshed every 10 seconds. */
export function BackendCards() {
  const perf = usePerformance();
  if (perf.error) return <ErrorText error={perf.error} />;
  if (!perf.data) return <Muted>Loading…</Muted>;
  if (perf.data.backends.length === 0) return <Muted>No backends configured.</Muted>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {perf.data.backends.map((b) => (
        <div key={b.name} className="rounded-md border border-line-2 bg-surface-2/50 p-3">
          <div className="flex items-center gap-2">
            <Dot ok={b.live.healthy} />
            <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
            <StateBadge state={b.state} />
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={b.models.join(", ")}>
            {b.models.join(", ") || "no models"}
          </p>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <Figure label="Running" value={b.live.running} />
            <Figure label="Waiting" value={b.live.waiting} />
            <Figure label="Open here" value={b.inflight} />
          </dl>
          {b.live.error && (
            <p className="mt-2 truncate font-mono text-[11px] text-danger" title={b.live.error}>
              {b.live.error}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 text-base font-semibold">{value}</dd>
    </div>
  );
}

export function ModelsPage() {
  const me = useMe();
  const perf = usePerformance();
  if (perf.error) return <ErrorText error={perf.error} />;
  if (!perf.data) return <Muted>Loading…</Muted>;
  const { backends, medians } = perf.data;
  const ids = [...new Set([...me.models, ...backends.flatMap((b) => b.models)])].sort();
  const level = (m: string) => me.logging.user ?? me.logging.models[m] ?? me.logging.default;

  return (
    <>
      <PageHeader title="Models" />
      {ids.length === 0 && <Muted>No models are configured.</Muted>}
      <div className="grid gap-4">
        {ids.map((id) => {
          const serving = backends.filter((b) => b.models.includes(id));
          const available = me.models.includes(id);
          return (
            <Panel
              key={id}
              title={
                <span className="flex items-center gap-2">
                  <Dot ok={available} />
                  <span className="font-mono">{id}</span>
                  <CopyButton text={id} />
                </span>
              }
              action={
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    Logging <span className="font-medium text-foreground">{level(id)}</span>
                  </span>
                  <Link to="/logs" search={{ model: id }}>
                    Logs
                  </Link>
                </span>
              }
              bodyClassName="p-0"
            >
              <BackendTable backends={serving} medians={medians.filter((m) => m.model === id)} />
            </Panel>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Medians cover successful generations in the last 24 hours.
      </p>
    </>
  );
}

function BackendTable({ backends, medians }: { backends: BackendView[]; medians: Median[] }) {
  if (backends.length === 0) return <Muted className="px-4">No backend serves this model.</Muted>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-2 text-left text-xs text-muted-foreground">
            <th className="py-2 pl-4 font-medium">Backend</th>
            <th className="px-2 font-medium">State</th>
            <th className="px-2 text-right font-medium">Running / waiting</th>
            <th className="px-2 text-right font-medium">Requests 24h</th>
            <th className="px-2 text-right font-medium">TTFT p50</th>
            <th className="px-2 text-right font-medium">tok/s p50</th>
            <th className="px-2 pr-4 text-right font-medium">tok/round p50</th>
          </tr>
        </thead>
        <tbody>
          {backends.map((b) => {
            const m = medians.find((x) => x.backend === b.name);
            return (
              <tr key={b.name} className="border-b border-line-2 last:border-0">
                <td className="py-1.5 pl-4">
                  <span className="flex items-center gap-2">
                    <Dot ok={b.live.healthy} />
                    {b.name}
                  </span>
                </td>
                <td className="px-2">
                  <StateBadge state={b.state} />
                </td>
                <td className="px-2 text-right">
                  {b.live.running} / {b.live.waiting}
                </td>
                <td className="px-2 text-right">{count(m?.requests)}</td>
                <td className="px-2 text-right">{ms(m?.ttftMs)}</td>
                <td className="px-2 text-right">{fixed(m?.decodeTps)}</td>
                <td className="px-2 pr-4 text-right">{fixed(m?.tokensPerRound, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
