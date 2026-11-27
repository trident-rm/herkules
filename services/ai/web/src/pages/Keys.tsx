import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../api.ts";
import { count, when } from "../format.ts";
import { Code, CopyButton, ErrorText, Muted, PageHeader, Panel } from "../ui.tsx";

/** The key created in this visit, so Setup can fill it in. Never stored. */
export let newSecret: string | undefined;

export function KeysPage() {
  const client = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string>();
  const create = useMutation({
    mutationFn: () => api.createKey(name.trim()),
    onSuccess: (made) => {
      newSecret = made.secret;
      setSecret(made.secret);
      setName("");
      void client.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeKey,
    onSuccess: () => client.invalidateQueries({ queryKey: ["keys"] }),
  });

  return (
    <>
      <PageHeader title="Keys">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name, e.g. laptop"
            className="h-8 w-56 bg-surface"
            aria-label="New key name"
          />
          <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
            Create key
          </Button>
        </form>
      </PageHeader>
      <ErrorText error={create.error ?? revoke.error} />
      {secret && (
        <div className="mb-4 rounded-lg border border-primary/50 bg-accent-soft p-4">
          <p className="text-sm">
            Copy this key now. It is not shown again.{" "}
            <Link to="/setup">Set up a client with it</Link>
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Code className="flex-1 bg-surface select-all">{secret}</Code>
            <CopyButton text={secret} />
          </div>
        </div>
      )}
      <Panel bodyClassName="p-0">
        {keys.error ? (
          <div className="px-4">
            <ErrorText error={keys.error} />
          </div>
        ) : !keys.data ? (
          <Muted className="px-4">Loading…</Muted>
        ) : keys.data.keys.length === 0 ? (
          <Muted className="px-4">No keys yet.</Muted>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-2 text-left text-xs text-muted-foreground">
                  <th className="py-2 pl-4 font-medium">Name</th>
                  <th className="px-2 font-medium">Key</th>
                  <th className="px-2 font-medium">Created</th>
                  <th className="px-2 font-medium">Last used</th>
                  <th className="px-2 text-right font-medium">Requests 30d</th>
                  <th className="px-2 text-right font-medium">In 30d</th>
                  <th className="px-2 text-right font-medium">Out 30d</th>
                  <th className="pr-4" />
                </tr>
              </thead>
              <tbody>
                {keys.data.keys.map((k) => (
                  <tr key={k.id} className="border-b border-line-2 last:border-0">
                    <td className="py-2 pl-4 font-medium">{k.name}</td>
                    <td className="px-2 font-mono text-xs">{k.prefix}…</td>
                    <td className="px-2 text-muted-foreground">{when(k.createdAt)}</td>
                    <td className="px-2 text-muted-foreground">{when(k.lastUsedAt)}</td>
                    <td className="px-2 text-right">{count(k.requests30d)}</td>
                    <td className="px-2 text-right">{count(k.promptTokens30d)}</td>
                    <td className="px-2 text-right">{count(k.outputTokens30d)}</td>
                    <td className="py-1 pr-4 text-right whitespace-nowrap">
                      <Button variant="ghost" size="xs" asChild>
                        <Link to="/logs" search={{ key: k.id }}>
                          Logs
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-danger hover:text-danger"
                        onClick={() => {
                          if (confirm(`Revoke "${k.name}"? Clients using it stop working.`))
                            revoke.mutate(k.id);
                        }}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
