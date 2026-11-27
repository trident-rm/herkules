/**
 * A collapsible JSON tree. Objects and arrays below `open` depth start expanded; long
 * strings and long arrays show their start and expand on click, so a 1 MB body renders
 * without freezing the panel.
 */
import { cn } from "@herkules/ui/lib/utils";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

const LONG_STRING = 400;
const LONG_ARRAY = 100;

export function JsonView({ value, open = 2 }: { value: unknown; open?: number }) {
  return (
    <div className="font-mono text-[12px] leading-[1.6]">
      <Node value={value} depth={0} open={open} />
    </div>
  );
}

function Node({
  name,
  value,
  depth,
  open,
  last = true,
}: {
  name?: string;
  value: unknown;
  depth: number;
  open: number;
  last?: boolean;
}) {
  const [expanded, setExpanded] = useState(depth < open);
  const comma = last ? "" : ",";
  const label = name !== undefined && <span className="text-ink-2">"{name}": </span>;

  if (value === null || typeof value !== "object")
    return (
      <div className="pl-4">
        {label}
        <Scalar value={value} />
        {comma}
      </div>
    );

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  const [openBrace, closeBrace] = isArray ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0)
    return (
      <div className="pl-4">
        {label}
        {openBrace}
        {closeBrace}
        {comma}
      </div>
    );

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-start text-left hover:bg-surface-2"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight
          className={cn(
            "mt-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span>
          {label}
          {openBrace}
          {!expanded && (
            <span className="text-muted-foreground">
              {" "}
              {isArray ? `${entries.length} items` : summary(entries)} {closeBrace}
              {comma}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <>
          <div className="ml-[7px] border-l border-line-2 pl-1">
            <Children entries={entries} isArray={isArray} depth={depth} open={open} />
          </div>
          <div className="pl-4">
            {closeBrace}
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

function Children({
  entries,
  isArray,
  depth,
  open,
}: {
  entries: [string, unknown][];
  isArray: boolean;
  depth: number;
  open: number;
}) {
  const [all, setAll] = useState(entries.length <= LONG_ARRAY);
  const shown = all ? entries : entries.slice(0, LONG_ARRAY);
  return (
    <>
      {shown.map(([k, v], i) => (
        <Node
          key={k}
          name={isArray ? undefined : k}
          value={v}
          depth={depth + 1}
          open={open}
          last={i === entries.length - 1}
        />
      ))}
      {!all && (
        <button type="button" className="pl-4 text-primary" onClick={() => setAll(true)}>
          {entries.length - LONG_ARRAY} more…
        </button>
      )}
    </>
  );
}

function Scalar({ value }: { value: unknown }) {
  const [full, setFull] = useState(false);
  if (typeof value === "string") {
    const long = value.length > LONG_STRING;
    const text = long && !full ? value.slice(0, LONG_STRING) : value;
    return (
      <span className="break-words whitespace-pre-wrap text-ok">
        "{text}
        {long && !full ? (
          <button type="button" className="text-primary" onClick={() => setFull(true)}>
            …{value.length - LONG_STRING} more
          </button>
        ) : (
          '"'
        )}
      </span>
    );
  }
  if (typeof value === "number") return <span className="text-primary">{value}</span>;
  return <span className="text-warn">{String(value)}</span>;
}

function summary(entries: [string, unknown][]): string {
  const keys = entries.slice(0, 4).map(([k]) => k);
  return keys.join(", ") + (entries.length > 4 ? ", …" : "");
}
