/** Small pieces every page repeats. */
import { cn } from "@herkules/ui/lib/utils";
import type { ComponentProps, ReactNode } from "react";

export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[1.35rem] font-medium">{title}</h2>
        {action}
      </div>
      {children}
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
        "overflow-x-auto rounded-md border border-line bg-surface p-3 font-mono text-[0.8rem] leading-relaxed",
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

export function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn("inline-block size-2 rounded-full", ok ? "bg-emerald-500" : "bg-red-500")}
      aria-label={ok ? "healthy" : "unhealthy"}
    />
  );
}
