import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@herkules/ui/components/table";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api.ts";
import { byDay, count, total, type Totals } from "../format.ts";
import { ErrorText, Muted, Section } from "../ui.tsx";

export function UsageTable({ rows, first }: { rows: [string, Totals][]; first: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{first}</TableHead>
          <TableHead className="text-right">Requests</TableHead>
          <TableHead className="text-right">Prompt</TableHead>
          <TableHead className="text-right">Cached</TableHead>
          <TableHead className="text-right">Output</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([label, t]) => (
          <TableRow key={label}>
            <TableCell>{label}</TableCell>
            <TableCell className="text-right">{count(t.requests)}</TableCell>
            <TableCell className="text-right">{count(t.promptTokens)}</TableCell>
            <TableCell className="text-right">{count(t.cachedTokens)}</TableCell>
            <TableCell className="text-right">{count(t.outputTokens)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function UsagePage() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api.usage(30) });
  if (usage.error) return <ErrorText error={usage.error} />;
  if (!usage.data) return <Muted>Loading…</Muted>;
  const rows = usage.data.days;
  return (
    <Section title="Your usage, last 30 days (UTC)">
      {rows.length === 0 ? (
        <Muted>No requests yet.</Muted>
      ) : (
        <UsageTable rows={[["Total", total(rows)], ...byDay(rows)]} first="Day" />
      )}
    </Section>
  );
}
