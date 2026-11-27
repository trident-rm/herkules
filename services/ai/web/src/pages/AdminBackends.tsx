import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, type BackendState, type BackendView } from "../api.ts";
import { when } from "../format.ts";
import { Code, Dot, ErrorText, Muted, PageHeader, Panel } from "../ui.tsx";
import { StateBadge, usePerformance } from "./Models.tsx";

export function AdminBackendsPage() {
  const client = useQueryClient();
  const perf = usePerformance();
  const refresh = () => client.invalidateQueries({ queryKey: ["performance"] });
  const state = useMutation({
    mutationFn: ({ name, s }: { name: string; s: BackendState }) => api.setBackendState(name, s),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeBackend, onSuccess: refresh });
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
      <Panel bodyClassName="p-0">
        {perf.data ? (
          <BackendTable backends={perf.data.backends} actions={actions} />
        ) : (
          <Muted className="px-4">Loading…</Muted>
        )}
      </Panel>
      <ErrorText error={perf.error ?? state.error ?? remove.error} />
      {perf.data?.tunnels && (
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

function BackendTable({
  backends,
  actions,
}: {
  backends: BackendView[];
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
              <td className="px-2 py-2 text-muted-foreground">{when(b.live.checkedAt)}</td>
              <td className="py-1.5 pr-4 text-right whitespace-nowrap">{actions(b)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
