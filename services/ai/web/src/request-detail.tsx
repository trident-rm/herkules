/** The side panel for one logged request: its metadata, then the stored bodies. */
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@herkules/ui/components/sheet";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import { api, type Bodies as BodiesData, type Person, type RequestRow } from "./api.ts";
import { assemble, parseBody } from "./body.ts";
import { useMe } from "./session.ts";
import { count, fixed, ms } from "./format.ts";
import { JsonView } from "./json-view.tsx";
import { Code, CopyButton, ErrorText, Muted, Segmented, StatusPill } from "./ui.tsx";

export function RequestSheet({
  id,
  known,
  people,
  onClose,
}: {
  id: number | undefined;
  /** The row when the list already has it, so the panel opens without a round trip. */
  known?: RequestRow;
  people: Record<string, Person>;
  onClose: () => void;
}) {
  return (
    <Sheet open={id !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-3xl">
        {id !== undefined && <Detail id={id} known={known} people={people} />}
      </SheetContent>
    </Sheet>
  );
}

function Detail({
  id,
  known,
  people,
}: {
  id: number;
  known?: RequestRow;
  people: Record<string, Person>;
}) {
  const me = useMe();
  const row = useQuery({
    queryKey: ["request", id],
    queryFn: () => api.request(id).then((r) => r.request),
    initialData: known,
  });
  if (row.error)
    return (
      <div className="p-5">
        <SheetTitle>Request #{id}</SheetTitle>
        <ErrorText error={row.error} />
      </div>
    );
  if (!row.data)
    return (
      <div className="p-5">
        <SheetTitle>Request #{id}</SheetTitle>
        <Muted>Loading…</Muted>
      </div>
    );
  const r = row.data;
  return (
    <>
      <div className="border-b border-line px-5 pt-5 pb-4">
        <div className="flex items-center gap-2 pr-8">
          <StatusPill row={r} />
          <SheetTitle className="truncate font-mono text-base">{r.model ?? r.route}</SheetTitle>
        </div>
        <SheetDescription className="mt-1 text-xs">
          #{r.id} · {new Date(r.at).toLocaleString()}
        </SheetDescription>
      </div>
      {r.error && (
        <div className="mx-5 mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-danger">
          {r.error}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 text-sm sm:grid-cols-4">
        <Field label="Route">
          {r.method} {r.route}
        </Field>
        <Field label="Backend">{r.backend ?? "–"}</Field>
        <Field label="Key">{r.keyName ?? "–"}</Field>
        <Field label="User">
          {people[r.sub]?.displayName ?? (r.sub === me.sub ? me.displayName : r.sub.slice(0, 12))}
        </Field>
        <Field label="Prompt tokens">{count(r.promptTokens)}</Field>
        <Field label="Cached tokens">{count(r.cachedTokens)}</Field>
        <Field label="Output tokens">{count(r.outputTokens)}</Field>
        <Field label="Effort">{r.effort ?? "–"}</Field>
        <Field label="Duration">{ms(r.durationMs)}</Field>
        <Field label="TTFT">{ms(r.ttftMs)}</Field>
        <Field label="Decode">{r.decodeTps === null ? "–" : `${fixed(r.decodeTps)} tok/s`}</Field>
        <Field label="Tokens per round">{fixed(r.tokensPerRound, 2)}</Field>
        <Field label="Streamed">{r.streamed ? "yes" : "no"}</Field>
        <Field label="Cancelled">{r.cancelled ? "yes" : "no"}</Field>
        <Field label="Logging">{r.level}</Field>
      </dl>
      <div className="border-t border-line px-5 py-4">
        {r.hasBody ? (
          <Bodies id={r.id} />
        ) : (
          <Muted className="py-0 text-sm">
            No stored bodies. Requests logged at the metadata level keep only these fields.
          </Muted>
        )}
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 truncate">{children}</dd>
    </div>
  );
}

type Side = "request" | "response";
type View = "tree" | "text" | "raw";

function Bodies({ id }: { id: number }) {
  const bodies = useQuery({ queryKey: ["bodies", id], queryFn: () => api.bodies(id) });
  if (bodies.error) return <ErrorText error={bodies.error} />;
  if (!bodies.data) return <Muted className="py-0">Loading bodies…</Muted>;
  return <BodyView b={bodies.data} />;
}

function BodyView({ b }: { b: BodiesData }) {
  const [side, setSide] = useState<Side>("response");
  // Unset until the reader picks one: streamed answers open as text, everything else as a tree.
  const [view, setView] = useState<View>();
  const raw = side === "request" ? b.request : b.response;
  const bytes = side === "request" ? b.requestBytes : b.responseBytes;
  const truncated = side === "request" ? b.requestTruncated : b.responseTruncated;
  const parsed = useMemo(() => parseBody(raw), [raw]);
  const text = useMemo(
    () => (side === "response" ? assemble(parsed) : { text: "", reasoning: "" }),
    [side, parsed],
  );
  const hasText = !!(text.text || text.reasoning);
  const views: { value: View; label: string }[] = [
    ...(parsed.kind !== "text" ? [{ value: "tree" as const, label: "Tree" }] : []),
    ...(hasText ? [{ value: "text" as const, label: "Text" }] : []),
    { value: "raw", label: "Raw" },
  ];
  const preferred = view ?? (hasText ? "text" : "tree");
  const shown = views.some((v) => v.value === preferred) ? preferred : views[0]!.value;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="Body"
          value={side}
          options={[
            { value: "request", label: "Request" },
            { value: "response", label: "Response" },
          ]}
          onChange={setSide}
        />
        <Segmented label="View" value={shown} options={views} onChange={setView} />
        <span className="ml-auto text-xs text-muted-foreground">
          {count(bytes)} bytes
          {parsed.kind === "events" && ` · ${parsed.events.length} events`}
          {truncated && " · truncated"}
        </span>
        <CopyButton text={raw} />
      </div>
      {shown === "tree" && parsed.kind !== "text" && (
        <div className="overflow-x-auto rounded-md border border-line bg-surface-2 p-2">
          <JsonView value={parsed.kind === "json" ? parsed.value : parsed.events} />
        </div>
      )}
      {shown === "text" && (
        <div className="grid gap-3">
          {text.reasoning && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Reasoning</p>
              <Code className="whitespace-pre-wrap text-muted-foreground">{text.reasoning}</Code>
            </div>
          )}
          {text.text && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Answer</p>
              <Code className="whitespace-pre-wrap font-sans text-sm">{text.text}</Code>
            </div>
          )}
        </div>
      )}
      {shown === "raw" && <Code className="max-h-[70vh] whitespace-pre-wrap break-all">{raw}</Code>}
    </>
  );
}
