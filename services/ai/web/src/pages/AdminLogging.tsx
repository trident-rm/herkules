import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, type Level } from "../api.ts";
import { ErrorText, Muted, PageHeader, Panel } from "../ui.tsx";

export function AdminLoggingPage() {
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
    <>
      <PageHeader title="Logging" />
      <p className="mb-3 text-sm text-muted-foreground">
        A user override wins over a model default; without either, requests are logged as metadata.
      </p>
      <Panel bodyClassName="p-0">
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
      </Panel>
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          set.mutate({ ...form, subject: form.subject.trim() });
        }}
      >
        <select
          className="h-8 rounded-md border border-line bg-surface px-2 text-sm"
          value={form.scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value as "user" | "model" })}
        >
          <option value="user">User (sub)</option>
          <option value="model">Model</option>
        </select>
        <Input
          className="h-8 w-80 bg-surface"
          placeholder={form.scope === "user" ? "User sub" : "Model id"}
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
        <select
          className="h-8 rounded-md border border-line bg-surface px-2 text-sm"
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
    </>
  );
}
