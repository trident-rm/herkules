import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  api,
  type BackendPolicy,
  type BackendState,
  type BackendView,
  type RoutingSettings,
} from "../api.ts";
import { when } from "../format.ts";
import { Code, Dot, ErrorText, Muted, PageHeader, Panel } from "../ui.tsx";
import { StateBadge, useLiveBackends } from "./Models.tsx";

export function AdminBackendsPage() {
  const client = useQueryClient();
  const live = useLiveBackends();
  const routing = useQuery({ queryKey: ["routing"], queryFn: api.routing });
  const refreshRouting = () => client.invalidateQueries({ queryKey: ["routing"] });
  const refresh = () =>
    Promise.all([client.invalidateQueries({ queryKey: ["live-backends"] }), refreshRouting()]);
  const [editing, setEditing] = useState<string>();
  const selected = live.data?.backends.find((backend) => backend.name === editing);
  const selectedPolicy = selected && routing.data?.backends[selected.name];
  const state = useMutation({
    mutationFn: ({ name, s }: { name: string; s: BackendState }) => api.setBackendState(name, s),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeBackend, onSettled: refresh });
  const [form, setForm] = useState({ name: "", models: "", port: "8000" });
  const [install, setInstall] = useState<{ hostname: string; install: string }>();
  const add = useMutation({
    mutationFn: () =>
      api.addBackend({
        name: form.name.trim(),
        models: form.models
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
        port: Number(form.port),
      }),
    onSuccess: (made) => {
      setInstall(made);
      setForm({ name: "", models: "", port: "8000" });
      void refresh();
    },
  });
  const actions = (b: BackendView) => (
    <span className="inline-flex gap-1">
      {routing.data?.backends[b.name] && (
        <Button variant="outline" size="xs" onClick={() => setEditing(b.name)}>
          Edit routing
        </Button>
      )}
      {(["enabled", "draining", "disabled"] as const)
        .filter((s) => s !== b.state)
        .map((s) => (
          <Button
            key={s}
            variant="outline"
            size="xs"
            onClick={() => state.mutate({ name: b.name, s })}
          >
            {s === "enabled" ? "Enable" : s === "draining" ? "Drain" : "Disable"}
          </Button>
        ))}
      {b.source?.kind === "tunnel" && (
        <Button
          variant="destructive"
          size="xs"
          onClick={() => {
            if (confirm(`Remove ${b.name}? This deletes its tunnel and DNS record.`))
              remove.mutate(b.name);
          }}
        >
          Remove
        </Button>
      )}
    </span>
  );

  return (
    <>
      <PageHeader title="Backends" />
      {routing.data && (
        <RoutingForm
          key={JSON.stringify(routing.data.settings)}
          settings={routing.data.settings}
          onSaved={refreshRouting}
        />
      )}
      <Panel bodyClassName="p-0" className="mt-4">
        {live.data ? (
          <BackendTable
            backends={live.data.backends}
            policies={routing.data?.backends}
            actions={actions}
          />
        ) : (
          <Muted className="px-4">Loading…</Muted>
        )}
      </Panel>
      <ErrorText error={live.error ?? routing.error ?? state.error ?? remove.error} />
      {selected && selectedPolicy && (
        <BackendPolicyForm
          key={selected.name}
          backend={selected}
          policy={selectedPolicy}
          onClose={() => setEditing(undefined)}
          onSaved={refreshRouting}
        />
      )}
      {live.data?.tunnels && (
        <Panel title="Add a GPU machine" className="mt-4">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <Input
              className="w-40"
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              className="w-72"
              placeholder="Model ids, comma-separated"
              value={form.models}
              onChange={(e) => setForm({ ...form, models: e.target.value })}
            />
            <Input
              className="w-28"
              placeholder="Port"
              inputMode="numeric"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: e.target.value })}
            />
            <Button type="submit" disabled={add.isPending || !form.name || !form.models}>
              {add.isPending ? "Creating tunnel…" : "Add machine"}
            </Button>
          </form>
        </Panel>
      )}
      <ErrorText error={add.error} />
      {install && (
        <div className="mt-4 rounded-md border border-primary p-4 text-sm">
          <p>
            {install.hostname} is ready. On the GPU machine, with <code>siphon-serve</code>{" "}
            listening on 127.0.0.1 at that port, run this once. The token is not shown again.
          </p>
          <Code className="mt-2 select-all whitespace-pre-wrap break-all">{install.install}</Code>
        </div>
      )}
    </>
  );
}

function RoutingForm({
  settings,
  onSaved,
}: {
  settings: RoutingSettings;
  onSaved: () => Promise<void>;
}) {
  const [strategy, setStrategy] = useState(settings.strategy);
  const [wait, setWait] = useState(String(settings.waitSeconds));
  const save = useMutation({ mutationFn: api.setRouting, onSuccess: onSaved });
  const descriptions = {
    leastLoaded: "Use the least-loaded server in the highest available priority tier.",
    roundRobin: "Rotate through available servers of the same priority for each model.",
    single: "Use one healthy server per model. When it fills up, wait for a slot on that server.",
  };

  return (
    <Panel title="Routing">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({ strategy, waitSeconds: Number(wait) });
        }}
      >
        <label className="grid gap-1 text-sm">
          Serving method
          <select
            className="h-9 rounded-md border border-line bg-surface px-2"
            value={strategy}
            onChange={(event) => setStrategy(event.target.value as RoutingSettings["strategy"])}
          >
            <option value="leastLoaded">Least loaded</option>
            <option value="roundRobin">Round robin</option>
            <option value="single">One server per model</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Queue timeout (seconds)
          <Input
            className="w-36"
            type="number"
            min={0}
            max={60}
            required
            value={wait}
            onChange={(event) => setWait(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          disabled={
            save.isPending ||
            (strategy === settings.strategy && wait === String(settings.waitSeconds))
          }
        >
          Save
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        {descriptions[strategy]} Requests wait for a healthy server with capacity. A timeout of 0
        returns immediately.
      </p>
      <ErrorText error={save.error} />
    </Panel>
  );
}

function BackendPolicyForm({
  backend,
  policy,
  onSaved,
  onClose,
}: {
  backend: BackendView;
  policy: BackendPolicy;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [priority, setPriority] = useState(String(policy.priority));
  const [maxStreams, setMaxStreams] = useState(policy.maxStreams?.toString() ?? "");
  const save = useMutation({
    mutationFn: (next: BackendPolicy) => api.setBackendPolicy(backend.name, next),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  return (
    <Panel title={`Routing for ${backend.name}`} className="mt-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({
            priority: Number(priority),
            maxStreams: maxStreams ? Number(maxStreams) : null,
          });
        }}
      >
        <label className="grid gap-1 text-sm">
          Priority
          <Input
            className="w-28"
            type="number"
            min={0}
            max={65535}
            required
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Max streams
          <Input
            className="w-36"
            type="number"
            min={1}
            max={65535}
            placeholder={backend.live.maxStreams?.toString() ?? "Auto"}
            value={maxStreams}
            onChange={(event) => setMaxStreams(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        Lower priority numbers are tried first. Leave max streams blank to use the server’s
        advertised capacity when available.
      </p>
      <ErrorText error={save.error} />
    </Panel>
  );
}

function BackendTable({
  backends,
  policies,
  actions,
}: {
  backends: BackendView[];
  policies: Record<string, BackendPolicy> | undefined;
  actions: (b: BackendView) => React.ReactNode;
}) {
  if (backends.length === 0) return <Muted className="px-4">No backends configured.</Muted>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-2 text-left text-xs text-muted-foreground">
            <th className="py-2 pl-4 font-medium">Backend</th>
            <th className="px-2 font-medium">Models</th>
            <th className="px-2 font-medium">State</th>
            <th className="px-2 text-right font-medium">Running / waiting</th>
            <th className="px-2 text-right font-medium">Open here</th>
            <th className="px-2 text-right font-medium">Priority / limit</th>
            <th className="px-2 font-medium">Checked</th>
            <th className="pr-4" />
          </tr>
        </thead>
        <tbody>
          {backends.map((b) => (
            <tr key={b.name} className="border-b border-line-2 align-top last:border-0">
              <td className="py-2 pl-4">
                <span className="flex items-center gap-2 font-medium">
                  <Dot ok={b.live.healthy} /> {b.name}
                </span>
                {b.source?.kind === "tunnel" && (
                  <span className="block text-xs text-muted-foreground">
                    {b.source.hostname} → :{b.source.port} · tunnel {b.live.tunnel ?? "unknown"}
                  </span>
                )}
                {b.live.error && (
                  <span className="block font-mono text-xs text-danger">{b.live.error}</span>
                )}
              </td>
              <td className="px-2 py-2 font-mono text-xs">{b.models.join(", ")}</td>
              <td className="px-2 py-2">
                <StateBadge state={b.state} />
              </td>
              <td className="px-2 py-2 text-right">
                {b.live.running} / {b.live.waiting}
              </td>
              <td className="px-2 py-2 text-right">{b.inflight}</td>
              <td className="px-2 py-2 text-right">
                {policies?.[b.name]?.priority ?? "–"} /{" "}
                {policies?.[b.name]?.maxStreams ??
                  (b.live.maxStreams == null ? "–" : `${b.live.maxStreams} (auto)`)}
              </td>
              <td className="px-2 py-2 text-muted-foreground">{when(b.live.checkedAt)}</td>
              <td className="py-1.5 pr-4 text-right whitespace-nowrap">{actions(b)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
