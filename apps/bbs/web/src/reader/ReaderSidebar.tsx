import { Button } from "@herkules/ui/components/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@herkules/ui/components/sheet";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type SectionId = "toc" | "ai" | "kb" | "resources";

export interface SidebarSection {
  readonly id: SectionId;
  readonly label: string;
  readonly node: ReactNode;
}

const SEC = "flex min-w-0 scroll-mt-4 flex-col gap-2.5";
const HEAD = "m-0 font-mono text-xs font-medium tracking-[0.04em] text-muted-foreground";

function Sections({ sections, prefix }: { sections: readonly SidebarSection[]; prefix: string }) {
  return sections.map((section) => (
    <section className={SEC} id={`${prefix}-${section.id}`} key={section.id}>
      <h2 className={HEAD}>{section.label}</h2>
      {section.node}
    </section>
  ));
}

/**
 * One set of sections, two shapes (the `lg` breakpoint decides which):
 *
 *  - wide: a sticky column holding every section at once,
 *  - narrow: a fixed dock of one button per section that raises the same
 *    sections as a bottom sheet and scrolls it to the section asked for.
 *
 * The open section is state only the narrow layout can enter: on a wide
 * screen the dock is hidden, so nothing can set it. The sheet owns Esc, the
 * backdrop and the body scroll lock; the dock stays clickable above it so a
 * reader can switch sections without closing first.
 */
export function ReaderSidebar({ sections }: { sections: readonly SidebarSection[] }) {
  const [open, setOpen] = useState<SectionId | null>(null);
  const dock = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`reader-sheet-${open}`)?.scrollIntoView({ block: "start" });
  }, [open]);

  if (sections.length === 0) return null;

  return (
    <>
      <aside
        className="sticky top-6 -mr-1.5 hidden max-h-[calc(100vh-3rem)] flex-col gap-6 overflow-y-auto pr-1.5 [overscroll-behavior:contain] [scrollbar-width:thin] lg:flex"
        aria-label="文章辅助"
      >
        <Sections sections={sections} prefix="reader-side" />
      </aside>

      <Sheet
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
      >
        <SheetContent
          side="bottom"
          className="max-h-[80dvh] gap-6 overflow-y-auto bg-paper px-4 pt-5 pb-24"
          aria-label="文章辅助"
          onInteractOutside={(event) => {
            if (dock.current?.contains(event.target as Node)) event.preventDefault();
          }}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>文章辅助</SheetTitle>
          </SheetHeader>
          <Sections sections={sections} prefix="reader-sheet" />
        </SheetContent>
      </Sheet>

      <div
        ref={dock}
        className="fixed right-3 bottom-4 left-3 z-[60] flex rounded-md bg-ink text-paper lg:hidden"
        role="toolbar"
        aria-label="文章辅助"
      >
        {sections.map((section) => (
          <Button
            variant="ghost"
            key={section.id}
            type="button"
            className="h-[50px] flex-1 rounded-none text-paper hover:bg-paper/10 hover:text-paper dark:hover:bg-paper/10 aria-pressed:bg-paper/20 [&+button]:border-l [&+button]:border-paper/25"
            aria-pressed={open === section.id}
            onClick={() => setOpen(open === section.id ? null : section.id)}
          >
            {section.label}
          </Button>
        ))}
      </div>
    </>
  );
}
