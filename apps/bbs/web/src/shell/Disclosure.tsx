import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@herkules/ui/components/accordion";
import type { ReactNode } from "react";

/** A single disclosure, composed from the shared shadcn keyboard/focus primitives. */
export function Disclosure({
  title,
  defaultOpen = false,
  className,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={defaultOpen ? "body" : undefined}
      className={className}
    >
      <AccordionItem value="body" className="border-0">
        <AccordionTrigger className="gap-2 py-1 text-[13px] font-semibold text-ink hover:no-underline">
          <span className="flex items-center gap-2">{title}</span>
        </AccordionTrigger>
        <AccordionContent className="pt-2 pb-1">{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
