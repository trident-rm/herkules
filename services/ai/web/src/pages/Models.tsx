import { cn } from "@herkules/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { api, type BackendView, type Median } from "../api.ts";
import { count, fixed, ms, stamp } from "../format.ts";
import { useMe } from "../session.ts";
import { CopyButton, Dot, ErrorText, Muted, PageHeader, Panel } from "../ui.tsx";

function usePerformance() {
  return useQuery({ queryKey: ["performance"], queryFn: api.performance, refetchInterval: 60_000 });
}

export function useLiveBackends() {
  return useQuery({
    queryKey: ["live-backends"],
    queryFn: api.liveBackends,
    refetchInterval: 5_000,
  });
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

/** One card per backend with its live health, load and throughput. */
export function BackendCards() {
  const live = useLiveBackends();
  if (live.error) return <ErrorText error={live.error} />;
  if (!live.data) return <Muted>Loading…</Muted>;
  if (live.data.backends.length === 0) return <Muted>No backends configured.</Muted>;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {live.data.backends.map((b) => (
          <div key={b.name} className="rounded-md border border-line-2 bg-surface-2/50 p-3">
            <div className="flex items-center gap-2">
              <Dot ok={b.live.healthy} />
              <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
              {b.live.sampledAt && (
                <time className="text-xs text-muted-foreground" dateTime={b.live.sampledAt}>
                  {stamp(b.live.sampledAt)}
                </time>
              )}
              <StateBadge state={b.state} />
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={b.models.join(", ")}>
              {b.models.join(", ") || "no models"}
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <Figure
                label="Active / capacity"
                value={
                  b.live.prefilling != null && b.live.decoding != null
                    ? `${count(b.live.prefilling + b.live.decoding)} / ${count(b.live.maxStreams)}`
                    : count(b.live.sampledAt ? b.live.running : null)
                }
              />
              <Figure
                label="Backend queue"
                value={count(b.live.sampledAt ? b.live.waiting : null)}
              />
              <Figure label="Gateway open" value={count(b.inflight)} />
            </dl>
            <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-line-2 pt-2 text-xs">
              <Figure label="Input tok/s" value={fixed(b.live.promptTps)} />
              <Figure label="Prefill tok/s" value={fixed(b.live.prefillTps)} />
              <Figure label="Output tok/s" value={fixed(b.live.decodeTps)} />
              <Figure label="Prefilling" value={count(b.live.prefilling)} />
              <Figure label="Decoding" value={count(b.live.decoding)} />
              <Figure label="Parked" value={count(b.live.parked)} />
            </dl>
            <SchedulerDetails live={b.live} />
            {b.live.error && (
              <p className="mt-2 truncate font-mono text-[11px] text-danger" title={b.live.error}>
                {b.live.error}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Input counts prompt tokens, including cached tokens, at first output. Prefill and phase
        counts require engine metrics.
      </p>
    </>
  );
}

function SchedulerDetails({ live }: { live: BackendView["live"] }) {
  if (live.parked == null && live.processStartedAt == null) return null;
  const used =
    live.kvFreePages != null && live.kvTotalPages != null
      ? live.kvTotalPages - live.kvFreePages
      : null;
  const occupancy = Object.entries(live.decodeByStreams ?? {}).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  const reasons = [
    ["queue_full", "Queue full"],
    ["draining", "Draining"],
    ["engine_unavailable", "Engine unavailable"],
  ] as const;
  return (
    <details className="mt-3 border-t border-line-2 pt-2 text-xs">
      <summary className="cursor-pointer font-medium">Scheduler details</summary>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <Figure
          label="KV pages used"
          value={used == null ? "–" : `${count(used)} / ${count(live.kvTotalPages)}`}
        />
        <Figure
          label="Draft accepted"
          value={
            live.speculativeAcceptance == null ? "–" : `${fixed(live.speculativeAcceptance * 100)}%`
          }
        />
        <Figure label="Fallback steps" value={count(live.fallbackSteps)} />
      </dl>
      {live.processStartedAt != null && (
        <p className="mt-2 text-muted-foreground">
          Engine started {new Date(live.processStartedAt * 1000).toLocaleString()}
        </p>
      )}
      <p className="mt-3 font-medium">Decode by active streams</p>
      {occupancy.length ? (
        <table className="w-full text-right tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="text-left">
                Streams
              </th>
              <th scope="col">Tokens</th>
              <th scope="col">Decode s</th>
              <th scope="col">tok/s</th>
            </tr>
          </thead>
          <tbody>
            {occupancy.map(([streams, sample]) => (
              <tr key={streams}>
                <th scope="row" className="text-left font-normal">
                  {streams}
                </th>
                <td>{count(sample.tokens)}</td>
                <td>{fixed(sample.seconds, 2)}</td>
                <td>{fixed(sample.tokens / sample.seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-muted-foreground">No decode samples in the latest interval.</p>
      )}
      <p className="mt-3 font-medium">Prefix cache</p>
      <table className="w-full text-right tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="text-left">
              Tier
            </th>
            <th scope="col">Reused tokens</th>
            <th scope="col">Restore time</th>
          </tr>
        </thead>
        <tbody>
          {(["gpu", "ram", "ssd"] as const).map((tier) => (
            <tr key={tier}>
              <th scope="row" className="text-left font-normal uppercase">
                {tier}
              </th>
              <td>{count(live.prefixCache?.[tier]?.tokens)}</td>
              <td>
                {live.prefixCache?.[tier] == null ? "–" : ms(live.prefixCache[tier].seconds * 1000)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 font-medium">Admission rejections</p>
      <dl className="mt-1 grid grid-cols-3 gap-2">
        {reasons.map(([reason, label]) => (
          <Figure key={reason} label={label} value={count(live.rejections?.[reason])} />
        ))}
      </dl>
      <p className="mt-2 text-muted-foreground">
        Counters cover the latest scrape interval. Decode tok/s uses the time spent decoding at each
        stream count.
      </p>
    </details>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export function ModelsPage() {
  const me = useMe();
  const perf = usePerformance();
  const live = useLiveBackends();
  if (perf.error) return <ErrorText error={perf.error} />;
  if (!perf.data) return <Muted>Loading…</Muted>;
  const { medians } = perf.data;
  const backends = live.data?.backends ?? perf.data.backends;
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
      <ErrorText error={live.error} />
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
                  {b.live.sampledAt ? `${b.live.running} / ${b.live.waiting}` : "–"}
                </td>
                <td className="px-2 text-right">{count(m?.requests)}</td>
                <td className="px-2 text-right">{ms(m?.ttftMs)}</td>
                <td className="px-2 pr-4 text-right">{fixed(m?.tokensPerRound, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
