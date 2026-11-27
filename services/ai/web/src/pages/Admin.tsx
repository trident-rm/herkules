import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@herkules/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, type BackendState, type BackendView, type Level } from "../api.ts";
import { byUser } from "../format.ts";
import { BackendTable, usePerformance } from "./Performance.tsx";
import { RequestLog } from "./Requests.tsx";
import { UsageTable } from "./Usage.tsx";
import { Code, ErrorText, Muted, Section } from "../ui.tsx";

export function AdminPage() {
  return (
    <>
      <Backends />
      <Usage />
      <Logging />
      <Section title="All requests">
        <RequestLog scope={{ all: true }} />
      </Section>
    </>
  );
}

function Backends() {
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
    <Section title="Backends">
      {perf.data ? (
        <BackendTable backends={perf.data.backends} actions={actions} />
      ) : (
        <Muted>Loading…</Muted>
      )}
      <ErrorText error={perf.error ?? state.error ?? remove.error} />
      {perf.data?.tunnels && (
        <form
          className="mt-4 flex flex-wrap items-end gap-2"
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
    </Section>
  );
}

function Usage() {
  const usage = useQuery({ queryKey: ["admin-usage"], queryFn: () => api.adminUsage(30) });
  if (usage.error) return <ErrorText error={usage.error} />;
  if (!usage.data) return <Muted>Loading…</Muted>;
  const { days, users } = usage.data;
  const rows = byUser(days).map(
    ([sub, t]) => [users[sub]?.displayName ?? sub, t] as [string, typeof t],
  );
  return (
    <Section title="Usage by user, last 30 days">
      {rows.length === 0 ? (
        <Muted>No requests yet.</Muted>
      ) : (
        <UsageTable rows={rows} first="User" />
      )}
    </Section>
  );
}

function Logging() {
  const client = useQueryClient();
  const logging = useQuery({ queryKey: ["logging"], queryFn: api.logging });
  const set = useMutation({
    mutationFn: ({
      scope,
      subject,
      level,
    }: {
      scope: "user" | "model";
      subject: string;
      level: Level | null;
    }) => api.setLogging(scope, subject, level),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["logging"] });
      void client.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const [form, setForm] = useState<{ scope: "user" | "model"; subject: string; level: Level }>({
    scope: "user",
    subject: "",
    level: "full",
  });
  if (logging.error) return <ErrorText error={logging.error} />;
  if (!logging.data) return <Muted>Loading…</Muted>;
  const { overrides, users } = logging.data;
  const rows = [
    ...Object.entries(overrides.users).map(([s, l]) => ({
      scope: "user" as const,
      subject: s,
      label: users[s]?.displayName ?? s,
      level: l,
    })),
    ...Object.entries(overrides.models).map(([s, l]) => ({
      scope: "model" as const,
      subject: s,
      label: s,
      level: l,
    })),
  ];
  return (
    <Section title="Logging levels">
      <p className="mb-3 text-sm text-muted-foreground">
        A user override wins over a model default; without either, requests are logged as metadata.
      </p>
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Scope</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Level</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.scope}/${r.subject}`}>
                <TableCell>{r.scope}</TableCell>
                <TableCell title={r.subject}>{r.label}</TableCell>
                <TableCell>{r.level}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => set.mutate({ scope: r.scope, subject: r.subject, level: null })}
                  >
                    Clear
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          set.mutate({ ...form, subject: form.subject.trim() });
        }}
      >
        <select
          className="h-9 rounded-md border border-line bg-transparent px-2 text-sm"
          value={form.scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value as "user" | "model" })}
        >
          <option value="user">User (sub)</option>
          <option value="model">Model</option>
        </select>
        <Input
          className="w-80"
          placeholder={form.scope === "user" ? "User sub" : "Model id"}
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
        <select
          className="h-9 rounded-md border border-line bg-transparent px-2 text-sm"
          value={form.level}
          onChange={(e) => setForm({ ...form, level: e.target.value as Level })}
        >
          <option value="full">full</option>
          <option value="metadata">metadata</option>
        </select>
        <Button type="submit" disabled={!form.subject.trim() || set.isPending}>
          Set
        </Button>
      </form>
      <ErrorText error={set.error} />
    </Section>
  );
}
