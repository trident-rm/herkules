import { Table, TableBody, TableRow, TableCell } from "@herkules/ui/components/table";
import { Disclosure } from "../shell/Disclosure.tsx";
import { Badge } from "@herkules/ui/components/badge";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { ArticleAiDTO } from "../../../src/api/dto.ts";

type KbEntry = NonNullable<ArticleAiDTO["kb"]>;

const SEC = "border-t border-line-2 pt-2 pb-1 text-[13.5px] leading-relaxed text-ink-2";
const FINE = "text-xs font-normal text-muted-foreground";
const ROW = "mb-1.5 [&_b]:mr-1 [&_b]:font-semibold [&_b]:text-ink";
const LIST =
  "m-0 list-disc pl-[18px] [&_a]:text-accent [&_b]:font-semibold [&_b]:text-ink [&_li]:my-1";
const WHY = "text-[13px] text-muted-foreground";

/**
 * The 规格 panel: the structured facts the model extracted, each section shown
 * only when it has rows. The page gates the whole panel (and its dock button)
 * on `hasContent(kb)` — rm-wenku showed an empty panel for every article whose
 * KB row happened to be all-empty lists.
 *
 * `KbPanelBody` is everything that is not a router link, split out so the
 * tables and lists can be rendered in a test without a router.
 */
export function KbPanel({ kb }: { kb: KbEntry }) {
  return (
    <div className="flex flex-col gap-2">
      <KbPanelBody kb={kb} />
      {kb.entities.length > 0 && (
        <div className={SEC}>
          <span className="label">相关条目</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {kb.entities.map((name) => (
              <Badge variant="outline" className="font-mono" key={name} asChild>
                <Link to="/kb/$name" params={{ name }}>
                  {name}
                </Link>
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function KbPanelBody({ kb }: { kb: KbEntry }) {
  return (
    <>
      <p className={FINE}>AI 提取，标注来源。</p>
      {(kb.problem ?? kb.approach) && (
        <div className={SEC}>
          {kb.problem && (
            <p className={ROW}>
              <b>问题</b> {kb.problem}
            </p>
          )}
          {kb.approach && (
            <p className={ROW}>
              <b>路线</b> {kb.approach}
            </p>
          )}
        </div>
      )}
      {kb.parameters.length > 0 && (
        <Section title="参数" count={kb.parameters.length} open>
          <Table
            aria-label="文章参数"
            className="min-w-[420px] border-collapse text-[13px] [&_td]:border-b [&_td]:border-line-2 [&_td]:py-[5px] [&_td]:pr-1.5 [&_td]:text-left [&_td]:align-top [&_tr:last-child_td]:border-b-0"
          >
            <TableBody>
              {kb.parameters.map((p, index) => (
                <TableRow key={index}>
                  <TableCell className="whitespace-nowrap">{p.name}</TableCell>
                  <TableCell className="pr-3! text-right font-mono whitespace-nowrap tabular-nums">
                    {p.value}
                    {p.unit ? ` ${p.unit}` : ""}
                  </TableCell>
                  <TableCell className="min-w-[160px] text-[12.5px] whitespace-normal text-muted-foreground">
                    {p.context}
                    {p.source && <span className="tag ml-1.5">{p.source}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
      {kb.components.length > 0 && (
        <Section title="组件" count={kb.components.length}>
          <ul className={LIST}>
            {kb.components.map((c, index) => (
              <li key={index}>
                <b>{c.name}</b>
                {c.kind && <span className="tag ml-1.5">{c.kind}</span>}
                {c.spec && <span> {c.spec}</span>}
                {c.role && <span className={FINE}> — {c.role}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kb.designDecisions.length > 0 && (
        <Section title="取舍" count={kb.designDecisions.length}>
          <ul className={LIST}>
            {kb.designDecisions.map((d, index) => (
              <li key={index}>
                <b>{d.decision}</b>
                {d.alternatives && <span className={FINE}> 而非 {d.alternatives}</span>}
                {d.rationale && <div className={WHY}>{d.rationale}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kb.pitfalls.length > 0 && (
        <Section title="踩坑" count={kb.pitfalls.length} open>
          <ul className={LIST}>
            {kb.pitfalls.map((p, index) => (
              <li key={index}>{p}</li>
            ))}
          </ul>
        </Section>
      )}
      {(kb.interfaces.length > 0 || kb.toolchain.length > 0 || kb.cost) && (
        <Section title="接口 · 工具链 · 成本">
          {kb.interfaces.length > 0 && (
            <p className={ROW}>
              <b>接口</b> {kb.interfaces.join("、")}
            </p>
          )}
          {kb.toolchain.length > 0 && (
            <p className={ROW}>
              <b>工具链</b> {kb.toolchain.join("、")}
            </p>
          )}
          {kb.cost && (
            <p className={ROW}>
              <b>成本</b> {kb.cost}
            </p>
          )}
        </Section>
      )}
      {kb.claims.length > 0 && (
        <Section title="作者主张" count={kb.claims.length}>
          <ul className={LIST}>
            {kb.claims.map((c, index) => (
              <li key={index}>
                {c.claim}
                {c.evidence && <span className={FINE}> — {c.evidence}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kb.references.length > 0 && (
        <Section title="参考" count={kb.references.length}>
          <ul className={LIST}>
            {kb.references.map((r, index) => (
              <li key={index}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer nofollow">
                    {r.title}
                  </a>
                ) : (
                  r.title
                )}
                {r.relation && <span className="tag ml-1.5">{r.relation}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kb.openQuestions.length > 0 && (
        <Section title="没说清的" count={kb.openQuestions.length}>
          <ul className={LIST}>
            {kb.openQuestions.map((q, index) => (
              <li key={index}>{q}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/** Independently collapsible sections keep parameters and pitfalls open initially. */
function Section({
  title,
  count,
  open,
  children,
}: {
  title: string;
  count?: number;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <Disclosure
      className={SEC}
      defaultOpen={open}
      title={
        <>
          {title}
          {count !== undefined && <span className={FINE}>{count}</span>}
        </>
      }
    >
      {children}
    </Disclosure>
  );
}
