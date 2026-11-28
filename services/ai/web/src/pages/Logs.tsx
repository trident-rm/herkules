import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@herkules/ui/components/select";
import { cn } from "@herkules/ui/lib/utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Radio, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type LogFilter, type Person, type Range, type RequestRow } from "../api.ts";
import { count, fixed, ms, shortRoute, stamp } from "../format.ts";
import { RequestSheet } from "../request-detail.tsx";
import type { LogsSearch } from "../routes.tsx";
import { ScopeSwitch } from "../scope.tsx";
import { RANGES, toScope, useMe } from "../session.ts";
import { ErrorText, Muted, PageHeader, Segmented, StatusPill } from "../ui.tsx";
import { useLiveBackends } from "./Models.tsx";

const PAGE = 100;
const RANGE_MS: Record<Range, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export function LogsPage() {
  const me = useMe();
  const search = useSearch({ from: "/logs" });
  const navigate = useNavigate({ from: "/logs" });
  const [live, setLive] = useState(false);
  const scope = toScope(search, me);
  const set = (patch: Partial<LogsSearch>, replace = false) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace });

  // `from` is fixed when the range is picked, so the query key stays stable while scrolling.
  const from = useMemo(
    () => (search.range ? new Date(Date.now() - RANGE_MS[search.range]).toISOString() : undefined),
    [search.range],
  );
  const filter: LogFilter = {
    ...scope,
    q: search.q,
    model: search.model,
    backend: search.backend,
    route: search.route,
    key: scope.all || scope.sub ? undefined : search.key,
    status: search.status,
    from,
  };
  const filtered = !!(
    search.q ||
    search.model ||
    search.backend ||
    search.route ||
    search.key ||
    search.status ||
    search.range
  );
  const [people, setPeople] = useState<Record<string, Person>>({});

  return (
    <div className="flex h-[calc(100dvh-5.5rem)] min-h-[28rem] flex-col md:h-[calc(100dvh-2.5rem)]">
      <PageHeader title="Logs">
        <ScopeSwitch
          search={search}
          people={people}
          onChange={(next) => set({ ...next, key: undefined })}
        />
        <Button
          variant={live ? "default" : "outline"}
          size="sm"
          onClick={() => setLive(!live)}
          aria-pressed={live}
        >
          <Radio className={cn(live && "animate-pulse")} />
          Live
        </Button>
      </PageHeader>
      <Filters search={search} set={set} keysVisible={!scope.all && !scope.sub} />
      {filtered && (
        <button
          type="button"
          className="mb-2 inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          onClick={() =>
            set({
              q: undefined,
              model: undefined,
              backend: undefined,
              route: undefined,
              key: undefined,
              status: undefined,
              range: undefined,
            })
          }
        >
          <X className="size-3" /> Clear filters
        </button>
      )}
      <Table
        key={JSON.stringify(filter)}
        filter={filter}
        live={live}
        showUser={!!(scope.all || scope.sub)}
        openId={search.id}
        onOpen={(id) => set({ id })}
        onUser={(user) => set({ user, scope: undefined, key: undefined })}
        onPeople={setPeople}
      />
    </div>
  );
}

function Filters({
  search,
  set,
  keysVisible,
}: {
  search: LogsSearch;
  set: (patch: Partial<LogsSearch>, replace?: boolean) => void;
  keysVisible: boolean;
}) {
  const me = useMe();
  const live = useLiveBackends();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys, enabled: keysVisible });
  const [q, setQ] = useState(search.q ?? "");
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  useEffect(() => {
    if (q === (search.q ?? "")) return;
    const timer = setTimeout(() => set({ q: q.trim() || undefined }, true), 300);
    return () => clearTimeout(timer);
  });

  const backends = live.data?.backends.map((b) => b.name) ?? [];
  const models = [
    ...new Set([...me.models, ...(live.data?.backends.flatMap((b) => b.models) ?? [])]),
  ].sort();
  const withCurrent = (list: string[], current?: string) =>
    current && !list.includes(current) ? [current, ...list] : list;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-72">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search model, key, error, id…"
          className="h-8 bg-surface pl-8"
          aria-label="Search requests"
        />
      </div>
      <FilterSelect
        label="Status"
        value={search.status}
        options={[
          { value: "ok", label: "Succeeded" },
          { value: "error", label: "Failed" },
          { value: "cancelled", label: "Cancelled" },
        ]}
        onChange={(status) => set({ status })}
      />
      <FilterSelect
        label="Model"
        value={search.model}
        options={withCurrent(models, search.model).map((m) => ({ value: m, label: m }))}
        onChange={(model) => set({ model })}
      />
      <FilterSelect
        label="Backend"
        value={search.backend}
        options={withCurrent(backends, search.backend).map((b) => ({ value: b, label: b }))}
        onChange={(backend) => set({ backend })}
      />
      {keysVisible && (
        <FilterSelect
          label="Key"
          value={search.key === undefined ? undefined : String(search.key)}
          options={(keys.data?.keys ?? []).map((k) => ({ value: String(k.id), label: k.name }))}
          onChange={(key) => set({ key: key === undefined ? undefined : Number(key) })}
        />
      )}
      <Segmented
        label="Time range"
        value={search.range ?? "any"}
        options={[
          { value: "any", label: "Any time" },
          ...RANGES.map((r) => ({ value: r, label: r })),
        ]}
        onChange={(r) => set({ range: r === "any" ? undefined : r })}
      />
    </div>
  );
}

const ANY = "__any";

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
}) {
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : (v as T))}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn("h-8 min-w-28 bg-surface text-xs", value && "border-primary/60")}
      >
        <span className="text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const HEADER = 32;
const ROW = 34;

function Table({
  filter,
  live,
  showUser,
  openId,
  onOpen,
  onUser,
  onPeople,
}: {
  filter: LogFilter;
  live: boolean;
  showUser: boolean;
  openId: number | undefined;
  onOpen: (id: number | undefined) => void;
  onUser: (sub: string) => void;
  onPeople: (people: Record<string, Person>) => void;
}) {
  const log = useInfiniteQuery({
    queryKey: ["requests", filter],
    queryFn: ({ pageParam }) => api.requests(filter, { before: pageParam, limit: PAGE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.requests.length === PAGE ? last.requests[last.requests.length - 1]!.id : undefined,
  });

  // Live tail: poll for rows newer than the newest one shown and prepend them.
  const [head, setHead] = useState<RequestRow[]>([]);
  const [headPeople, setHeadPeople] = useState<Record<string, Person>>({});
  const newest = head[0]?.id ?? log.data?.pages[0]?.requests[0]?.id;
  const tail = useQuery({
    queryKey: ["requests-tail", filter, newest ?? 0],
    queryFn: () => api.requests(filter, { after: newest, limit: 200 }),
    enabled: live && log.isSuccess,
    refetchInterval: 3000,
  });
  useEffect(() => {
    const fresh = tail.data?.requests;
    if (!fresh?.length) return;
    setHead((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [...fresh.filter((r) => !seen.has(r.id)), ...prev];
    });
    setHeadPeople((prev) => ({ ...prev, ...tail.data!.users }));
  }, [tail.data]);

  const rows = useMemo(() => {
    const older = log.data?.pages.flatMap((p) => p.requests) ?? [];
    const seen = new Set(head.map((r) => r.id));
    return [...head, ...older.filter((r) => !seen.has(r.id))];
  }, [head, log.data]);
  const people = useMemo(
    () => Object.assign({}, ...(log.data?.pages.map((p) => p.users) ?? []), headPeople),
    [log.data, headPeople],
  ) as Record<string, Person>;
  useEffect(() => onPeople(people), [people, onPeople]);

  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length + (log.hasNextPage ? 1 : 0),
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 20,
    scrollMargin: HEADER,
  });
  const items = virtual.getVirtualItems();
  const lastIndex = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (lastIndex >= rows.length - 1 && log.hasNextPage && !log.isFetchingNextPage)
      void log.fetchNextPage();
  }, [lastIndex, rows.length, log]);

  const columns = cn(
    "grid items-center gap-x-3 px-3",
    showUser
      ? "grid-cols-[112px_120px_52px_minmax(140px,1.4fr)_minmax(130px,1fr)_100px_124px_68px_68px_56px]"
      : "grid-cols-[112px_52px_minmax(140px,1.4fr)_minmax(130px,1fr)_100px_124px_68px_68px_56px]",
  );

  return (
    <>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-surface"
      >
        <div className="min-w-[960px]">
          <div
            className={cn(
              columns,
              "sticky top-0 z-10 border-b border-line bg-surface text-xs font-medium text-muted-foreground",
            )}
            style={{ height: HEADER }}
          >
            <span>Time</span>
            {showUser && <span>User</span>}
            <span>Status</span>
            <span>Model</span>
            <span>Route</span>
            <span>Key</span>
            <span className="text-right">Tokens in → out</span>
            <span className="text-right">TTFT</span>
            <span className="text-right">Duration</span>
            <span className="text-right">tok/s</span>
          </div>
          {log.error ? (
            <div className="px-3">
              <ErrorText error={log.error} />
            </div>
          ) : !log.data ? (
            <Muted className="px-3">Loading…</Muted>
          ) : rows.length === 0 ? (
            <Muted className="px-3">No requests match.</Muted>
          ) : (
            <div className="relative" style={{ height: virtual.getTotalSize() }}>
              {items.map((item) => {
                const r = rows[item.index];
                return (
                  <div
                    key={item.key}
                    className="absolute inset-x-0"
                    style={{ height: item.size, transform: `translateY(${item.start - HEADER}px)` }}
                  >
                    {r ? (
                      <LogRow
                        row={r}
                        columns={columns}
                        showUser={showUser}
                        name={people[r.sub]?.displayName}
                        open={openId === r.id}
                        onOpen={() => onOpen(r.id)}
                        onUser={() => onUser(r.sub)}
                      />
                    ) : (
                      <p className="px-3 py-2 text-xs text-muted-foreground">Loading older…</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {count(rows.length)} loaded{log.hasNextPage ? ", scroll for older" : ""}
        {live && " · live, every 3 s"}
      </p>
      <RequestSheet
        id={openId}
        known={rows.find((r) => r.id === openId)}
        people={people}
        onClose={() => onOpen(undefined)}
      />
    </>
  );
}

function LogRow({
  row: r,
  columns,
  showUser,
  name,
  open,
  onOpen,
  onUser,
}: {
  row: RequestRow;
  columns: string;
  showUser: boolean;
  name: string | undefined;
  open: boolean;
  onOpen: () => void;
  onUser: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        columns,
        "h-full cursor-pointer border-b border-line-2 text-[13px] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none",
        open && "bg-accent-soft hover:bg-accent-soft",
      )}
    >
      <span className="text-xs text-muted-foreground">{stamp(r.at)}</span>
      {showUser && (
        <button
          type="button"
          className="truncate text-left text-xs hover:text-primary"
          title={r.sub}
          onClick={(e) => {
            e.stopPropagation();
            onUser();
          }}
        >
          {name ?? r.sub.slice(0, 10)}
        </button>
      )}
      <span>
        <StatusPill row={r} />
      </span>
      <span className="truncate font-mono text-xs" title={r.model ?? undefined}>
        {r.model ?? "–"}
        {r.backend && <span className="text-muted-foreground"> · {r.backend}</span>}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="truncate">{shortRoute(r.route)}</span>
        {r.streamed && <Tag>stream</Tag>}
        {r.effort && <Tag>{r.effort}</Tag>}
      </span>
      <span className="truncate text-xs text-muted-foreground">{r.keyName ?? "–"}</span>
      <span
        className="text-right text-xs whitespace-nowrap"
        title={r.cachedTokens ? `${r.cachedTokens.toLocaleString()} cached` : undefined}
      >
        {count(r.promptTokens)} <span className="text-muted-foreground">→</span>{" "}
        {count(r.outputTokens)}
      </span>
      <span className="text-right text-xs">{ms(r.ttftMs)}</span>
      <span className="text-right text-xs">{ms(r.durationMs)}</span>
      <span className="text-right text-xs">{fixed(r.decodeTps)}</span>
    </div>
  );
}

function Tag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded border border-line px-1 text-[10px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}
