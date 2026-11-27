/** Small pieces every page repeats. */
import { cn } from "@herkules/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import type { RequestRow } from "./api.ts";
import { outcome } from "./outcome.ts";

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** A bordered block with an optional title row. */
export function Panel({
  title,
  action,
  className,
  bodyClassName,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border border-line bg-surface", className)}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-2.5">
          <h2 className="text-sm font-medium">{title}</h2>
          {action}
        </div>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Muted({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("py-4 text-muted-foreground", className)} {...props} />;
}

export function Code({ className, ...props }: ComponentProps<"pre">) {
  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-[0.8rem] leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="py-2 text-destructive">
      {error instanceof Error ? error.message : "Something went wrong."}
    </p>
  );
}

export function Dot({ ok, className }: { ok: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        ok ? "bg-ok" : "bg-danger",
        className,
      )}
      aria-label={ok ? "healthy" : "unhealthy"}
    />
  );
}

/** A row of mutually exclusive buttons; the URL usually holds the value. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-line bg-surface p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-[4px] px-2.5 text-xs font-medium text-muted-foreground transition-colors",
            value === o.value ? "bg-surface-2 text-foreground shadow-xs" : "hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function StatusPill({ row }: { row: Pick<RequestRow, "status" | "error" | "cancelled"> }) {
  const o = outcome(row);
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-10 items-center justify-center rounded px-1.5 font-mono text-[11px] font-medium",
        o === "ok" && "bg-ok-soft text-ok",
        o === "error" && "bg-danger-soft text-danger",
        o === "cancelled" && "bg-surface-2 text-muted-foreground",
      )}
      title={o === "cancelled" ? "Cancelled by the client" : (row.error ?? undefined)}
    >
      {row.status}
    </span>
  );
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      className={cn(
        "inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground",
        className,
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}
