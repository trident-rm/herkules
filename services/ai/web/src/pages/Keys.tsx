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

import { api, type Me } from "../api.ts";
import { when } from "../format.ts";
import { snippets } from "../setup.ts";
import { Code, ErrorText, Muted, Section } from "../ui.tsx";

export function KeysPage({ me }: { me: Me }) {
  const client = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string>();
  const create = useMutation({
    mutationFn: () => api.createKey(name),
    onSuccess: (made) => {
      setSecret(made.secret);
      setName("");
      void client.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeKey,
    onSuccess: () => client.invalidateQueries({ queryKey: ["keys"] }),
  });
  const model = me.models[0] ?? "<model>";

  return (
    <>
      <Section title="API keys">
        <form
          className="flex max-w-lg gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name, e.g. laptop"
          />
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Create key
          </Button>
        </form>
        <ErrorText error={create.error ?? revoke.error} />
        {secret && (
          <div className="mt-4 rounded-md border border-primary p-4">
            <p className="text-sm">Copy this key now. It is not shown again.</p>
            <Code className="mt-2 select-all">{secret}</Code>
          </div>
        )}
        {keys.data && keys.data.keys.length === 0 && <Muted>No keys yet.</Muted>}
        {keys.data && keys.data.keys.length > 0 && (
          <Table className="mt-4">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell>{k.name}</TableCell>
                  <TableCell className="font-mono">{k.prefix}…</TableCell>
                  <TableCell>{when(k.createdAt)}</TableCell>
                  <TableCell>{when(k.lastUsedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Revoke "${k.name}"? Clients using it stop working.`))
                          revoke.mutate(k.id);
                      }}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Setup">
        <p className="text-sm text-muted-foreground">
          Models: {me.models.length ? me.models.join(", ") : "none available right now"}. Your
          logging level:{" "}
          {me.logging.user ??
            (Object.values(me.logging.models).includes("full") ? "per model" : me.logging.default)}
          {Object.keys(me.logging.models).length > 0 && !me.logging.user && (
            <>
              {" "}
              (
              {Object.entries(me.logging.models)
                .map(([m, l]) => `${m}: ${l}`)
                .join(", ")}
              )
            </>
          )}
          . Full logging stores request and response bodies, which you and admins can read.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {snippets(me.apiOrigin, model, secret ?? "<your key>").map((s) => (
            <div key={s.id}>
              <p className="text-sm font-medium">
                {s.title} <span className="font-normal text-muted-foreground">· {s.file}</span>
              </p>
              <Code className="mt-1">{s.text}</Code>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
