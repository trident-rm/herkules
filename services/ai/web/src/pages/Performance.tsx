import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@herkules/ui/components/table";
import { useQuery } from "@tanstack/react-query";

import { api, type BackendView } from "../api.ts";
import { count, fixed, ms, when } from "../format.ts";
import { Dot, ErrorText, Muted, Section } from "../ui.tsx";

export function usePerformance() {
  return useQuery({ queryKey: ["performance"], queryFn: api.performance, refetchInterval: 10_000 });
}

export function BackendTable({
  backends,
  actions,
}: {
  backends: BackendView[];
  actions?: (b: BackendView) => React.ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Backend</TableHead>
          <TableHead>Models</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="text-right">Running / waiting</TableHead>
          <TableHead className="text-right">Open here</TableHead>
          <TableHead>Checked</TableHead>
          {actions && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {backends.map((b) => (
          <TableRow key={b.name}>
            <TableCell>
              <span className="flex items-center gap-2">
                <Dot ok={b.live.healthy} /> {b.name}
              </span>
              {b.live.error && (
                <span className="block text-xs text-muted-foreground">{b.live.error}</span>
              )}
              {b.source?.kind === "tunnel" && (
                <span className="block text-xs text-muted-foreground">
                  {b.source.hostname} → :{b.source.port} · tunnel {b.live.tunnel ?? "unknown"}
                </span>
              )}
            </TableCell>
            <TableCell>{b.models.join(", ")}</TableCell>
            <TableCell>{b.state}</TableCell>
            <TableCell className="text-right">
              {b.live.running} / {b.live.waiting}
            </TableCell>
            <TableCell className="text-right">{b.inflight}</TableCell>
            <TableCell>{when(b.live.checkedAt)}</TableCell>
            {actions && (
              <TableCell className="text-right whitespace-nowrap">{actions(b)}</TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function PerformancePage() {
  const perf = usePerformance();
  if (perf.error) return <ErrorText error={perf.error} />;
  if (!perf.data) return <Muted>Loading…</Muted>;
  return (
    <>
      <Section title="Medians, last 24 hours">
        {perf.data.medians.length === 0 ? (
          <Muted>No successful generations yet.</Muted>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Backend</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">TTFT</TableHead>
                <TableHead className="text-right">Decode tok/s</TableHead>
                <TableHead className="text-right">Tokens per round</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {perf.data.medians.map((m) => (
                <TableRow key={`${m.model}/${m.backend}`}>
                  <TableCell>{m.model}</TableCell>
                  <TableCell>{m.backend}</TableCell>
                  <TableCell className="text-right">{count(m.requests)}</TableCell>
                  <TableCell className="text-right">{ms(m.ttftMs)}</TableCell>
                  <TableCell className="text-right">{fixed(m.decodeTps)}</TableCell>
                  <TableCell className="text-right">{fixed(m.tokensPerRound, 2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      <Section title="Backends">
        <BackendTable backends={perf.data.backends} />
      </Section>
    </>
  );
}
