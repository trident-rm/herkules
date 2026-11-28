import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, type BodyRetention, type Level } from "../api.ts";
import { when } from "../format.ts";
import { ErrorText, Muted, PageHeader, Panel } from "../ui.tsx";

type Logging = Awaited<ReturnType<typeof api.logging>>;

const selectClass = "h-8 rounded-md border border-line bg-surface px-2 text-sm";

function diskBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function LogStorage() {
  const query = useQuery({ queryKey: ["log-storage"], queryFn: api.logStorage, staleTime: 30_000 });
  const data = query.data;
  return (
    <Panel
      title="Stored logs"
      action={
        <Button
          variant="ghost"
          size="xs"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
      }
    >
      <ErrorText error={query.error} />
      {!data && !query.error && <Muted>Loading…</Muted>}
      {data && (
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Request records</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">
              {data.storage.requestRecords.toLocaleString()}
            </dd>
            <dd className="text-sm text-muted-foreground">
              {diskBytes(data.storage.requestDiskBytes)} on disk
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Stored body pairs</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">
              {data.storage.bodyRecords.toLocaleString()}
            </dd>
            <dd className="text-sm text-muted-foreground">
              {diskBytes(data.storage.bodyDiskBytes)} on disk
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Next cleanup</dt>
            <dd className="mt-1 text-xl font-semibold">
              {data.nextCleanup ? (
                <time dateTime={data.nextCleanup}>{when(data.nextCleanup)}</time>
              ) : (
                "Running"
              )}
            </dd>
          </div>
        </dl>
      )}
    </Panel>
  );
}

function CaptureLevels({ logging }: { logging: Logging }) {
  const client = useQueryClient();
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
  const { overrides, users, bodyLimitBytes } = logging;
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
    <Panel title="Capture level" bodyClassName="p-0">
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Requests default to metadata. User overrides take precedence over model defaults. Full
        logging also stores the request and response bodies, capped at {diskBytes(bodyLimitBytes)}{" "}
        each.
      </p>
      <div className="overflow-x-auto">
        {rows.length === 0 ? (
          <Muted className="px-4">No overrides.</Muted>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-2 text-left text-xs text-muted-foreground">
                <th className="py-2 pl-4 font-medium">Scope</th>
                <th className="px-2 font-medium">Subject</th>
                <th className="px-2 font-medium">Level</th>
                <th className="pr-4" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.scope}/${r.subject}`}
                  className="border-b border-line-2 last:border-0"
                >
                  <td className="py-2 pl-4">{r.scope}</td>
                  <td className="px-2" title={r.subject}>
                    {r.label}
                  </td>
                  <td className="px-2">{r.level}</td>
                  <td className="py-1 pr-4 text-right">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={set.isPending}
                      onClick={() =>
                        set.mutate({ scope: r.scope, subject: r.subject, level: null })
                      }
                    >
                      Clear
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <form
        className="flex flex-wrap items-end gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          set.mutate({ ...form, subject: form.subject.trim() });
        }}
      >
        <select
          aria-label="Override scope"
          className={selectClass}
          value={form.scope}
          onChange={(e) =>
            setForm({ ...form, scope: e.target.value as "user" | "model", subject: "" })
          }
        >
          <option value="user">User (sub)</option>
          <option value="model">Model</option>
        </select>
        <Input
          aria-label={form.scope === "user" ? "User sub" : "Model id"}
          className="h-8 w-80 max-w-full bg-surface"
          placeholder={form.scope === "user" ? "User sub" : "Model id"}
          list={form.scope === "model" ? "logging-models" : undefined}
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
        <select
          aria-label="Capture level"
          className={selectClass}
          value={form.level}
          onChange={(e) => setForm({ ...form, level: e.target.value as Level })}
        >
          <option value="full">Full</option>
          <option value="metadata">Metadata</option>
        </select>
        <Button type="submit" disabled={!form.subject.trim() || set.isPending}>
          Set
        </Button>
      </form>
      {set.error && (
        <div className="px-4">
          <ErrorText error={set.error} />
        </div>
      )}
    </Panel>
  );
}

function RetentionPolicies({ logging }: { logging: Logging }) {
  const client = useQueryClient();
  const [form, setForm] = useState<{ model: string; mode: BodyRetention["mode"]; days: string }>({
    model: "",
    mode: "default",
    days: String(logging.defaultRetentionDays),
  });
  const set = useMutation({
    mutationFn: ({ model, policy }: { model: string; policy: BodyRetention }) =>
      api.setBodyRetention(model, policy),
    onSuccess: () => client.invalidateQueries({ queryKey: ["logging"] }),
  });
  const selectModel = (model: string) => {
    const policy = logging.retention[model.trim()];
    setForm({
      model,
      mode: policy?.mode ?? "default",
      days: String(policy?.mode === "days" ? policy.days : logging.defaultRetentionDays),
    });
  };
  return (
    <Panel title="Body retention" bodyClassName="p-0">
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Policies apply to existing and future bodies stored by full logging. Keep for training holds
        bodies until the policy changes. Cleanup leaves request metadata in the log.
      </p>
      {logging.models.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-2 text-left text-xs text-muted-foreground">
                <th className="py-2 pl-4 font-medium">Model</th>
                <th className="px-2 font-medium">Retention</th>
                <th className="pr-4" />
              </tr>
            </thead>
            <tbody>
              {logging.models.map((model) => {
                const policy = logging.retention[model];
                return (
                  <tr key={model} className="border-b border-line-2">
                    <td className="py-2 pl-4">{model}</td>
                    <td className="px-2">
                      {policy?.mode === "days"
                        ? `${policy.days} days`
                        : policy?.mode === "forever"
                          ? "Keep for training"
                          : `Default (${logging.defaultRetentionDays} days)`}
                    </td>
                    <td className="py-1 pr-4 text-right">
                      <Button variant="ghost" size="xs" onClick={() => selectModel(model)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="flex flex-wrap items-end gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const policy: BodyRetention =
            form.mode === "days" ? { mode: "days", days: Number(form.days) } : { mode: form.mode };
          set.mutate({ model: form.model.trim(), policy });
        }}
      >
        <Input
          aria-label="Model id"
          className="h-8 w-80 max-w-full bg-surface"
          list="logging-models"
          placeholder="Model id"
          required
          value={form.model}
          onChange={(e) => selectModel(e.target.value)}
        />
        <select
          aria-label="Body retention"
          className={selectClass}
          value={form.mode}
          onChange={(e) => setForm({ ...form, mode: e.target.value as BodyRetention["mode"] })}
        >
          <option value="default">Default ({logging.defaultRetentionDays} days)</option>
          <option value="days">Custom days</option>
          <option value="forever">Keep for training</option>
        </select>
        {form.mode === "days" && (
          <Input
            aria-label="Retention days"
            className="h-8 w-24 bg-surface"
            type="number"
            min={1}
            max={36500}
            required
            value={form.days}
            onChange={(e) => setForm({ ...form, days: e.target.value })}
          />
        )}
        <Button type="submit" disabled={!form.model.trim() || set.isPending}>
          Save
        </Button>
      </form>
      {set.error && (
        <div className="px-4">
          <ErrorText error={set.error} />
        </div>
      )}
    </Panel>
  );
}

export function AdminLoggingPage() {
  const logging = useQuery({ queryKey: ["logging"], queryFn: api.logging });
  return (
    <>
      <PageHeader title="Logging" />
      <div className="space-y-4">
        <LogStorage />
        <ErrorText error={logging.error} />
        {!logging.data && !logging.error && <Muted>Loading…</Muted>}
        {logging.data && (
          <>
            <datalist id="logging-models">
              {logging.data.models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <CaptureLevels logging={logging.data} />
            <RetentionPolicies logging={logging.data} />
          </>
        )}
      </div>
    </>
  );
}
