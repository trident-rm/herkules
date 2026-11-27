import { Button } from "@herkules/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@herkules/ui/components/table";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api, type Me, type RequestRow } from "../api.ts";
import { count, fixed, ms, when } from "../format.ts";
import { Code, ErrorText, Muted, Section } from "../ui.tsx";

export function RequestLog({ scope }: { scope: { sub?: string; all?: boolean } }) {
  const [open, setOpen] = useState<number>();
  const log = useInfiniteQuery({
    queryKey: ["requests", scope],
    queryFn: ({ pageParam }) => api.requests({ ...scope, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.requests.length === 50 ? last.requests[last.requests.length - 1]!.id : undefined,
  });
  if (log.error) return <ErrorText error={log.error} />;
  if (!log.data) return <Muted>Loading…</Muted>;
  const rows = log.data.pages.flatMap((p) => p.requests);
  if (rows.length === 0) return <Muted>No requests yet.</Muted>;
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            {scope.all && <TableHead>User</TableHead>}
            <TableHead>Route</TableHead>
            <TableHead>Model · backend</TableHead>
            <TableHead className="text-right">Status</TableHead>
            <TableHead className="text-right">Prompt / cached / out</TableHead>
            <TableHead className="text-right">TTFT</TableHead>
            <TableHead className="text-right">tok/s</TableHead>
            <TableHead className="text-right">tok/round</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              showUser={!!scope.all}
              open={open === r.id}
              toggle={() => setOpen(open === r.id ? undefined : r.id)}
            />
          ))}
        </TableBody>
      </Table>
      {log.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void log.fetchNextPage()}
        >
          Older
        </Button>
      )}
    </>
  );
}

function Row({
  row: r,
  showUser,
  open,
  toggle,
}: {
  row: RequestRow;
  showUser: boolean;
  open: boolean;
  toggle: () => void;
}) {
  return (
    <>
      <TableRow>
        <TableCell className="whitespace-nowrap">{when(r.at)}</TableCell>
        {showUser && <TableCell className="font-mono text-xs">{r.sub.slice(0, 8)}</TableCell>}
        <TableCell className="font-mono text-xs">
          {r.route}
          {r.streamed ? " · stream" : ""}
          {r.effort ? ` · ${r.effort}` : ""}
        </TableCell>
        <TableCell>
          {r.model ?? "–"} · {r.backend ?? "–"}
        </TableCell>
        <TableCell className="text-right" title={r.error ?? undefined}>
          {r.status}
          {r.error ? " · error" : ""}
          {r.cancelled ? " · cancelled" : ""}
        </TableCell>
        <TableCell className="text-right whitespace-nowrap">
          {count(r.promptTokens)} / {count(r.cachedTokens)} / {count(r.outputTokens)}
        </TableCell>
        <TableCell className="text-right">{ms(r.ttftMs)}</TableCell>
        <TableCell className="text-right">{fixed(r.decodeTps)}</TableCell>
        <TableCell className="text-right">{fixed(r.tokensPerRound, 2)}</TableCell>
        <TableCell className="text-right">
          {r.hasBody && (
            <Button variant="ghost" size="xs" onClick={toggle}>
              {open ? "Hide" : "Bodies"}
            </Button>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={showUser ? 10 : 9}>
            <BodyView id={r.id} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function BodyView({ id }: { id: number }) {
  const bodies = useQuery({ queryKey: ["bodies", id], queryFn: () => api.bodies(id) });
  if (bodies.error) return <ErrorText error={bodies.error} />;
  if (!bodies.data) return <Muted>Loading…</Muted>;
  const b = bodies.data;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div>
        <p className="text-sm font-medium">
          Request · {count(b.requestBytes)} bytes{b.requestTruncated ? " · truncated" : ""}
        </p>
        <Code className="mt-1 max-h-96 whitespace-pre-wrap">{b.request}</Code>
      </div>
      <div>
        <p className="text-sm font-medium">
          Response · {count(b.responseBytes)} bytes{b.responseTruncated ? " · truncated" : ""}
        </p>
        <Code className="mt-1 max-h-96 whitespace-pre-wrap">{b.response}</Code>
      </div>
    </div>
  );
}

export function RequestsPage({ me }: { me: Me }) {
  return (
    <Section title="Your requests">
      <p className="mb-3 text-sm text-muted-foreground">
        Bodies are stored only for requests logged at the full level
        {me.logging.user ? ` (yours: ${me.logging.user})` : ""}.
      </p>
      <RequestLog scope={{}} />
    </Section>
  );
}
