/**
 * `/kb` — the knowledge-base browse screen: facets, the card grid, and a summary
 * column (pitfall teaser + entity tallies) derived from the SAME cards the grid
 * shows, so the tallies always agree with the current filter (`kb/model.ts`).
 */
import { Badge } from "@herkules/ui/components/badge";
import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";

import type { KbBrowseDTO } from "../../../src/api/dto.ts";
import { Disclosure } from "../shell/Disclosure.tsx";
import { kbRoute } from "../routes.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";
import type { KbSearch } from "../url.ts";
import { KbCardBody } from "./KbCard.tsx";
import type { KbCardDTO } from "./KbCard.tsx";
import { PITFALL_LIMIT, countEntities, roundRobin, splitEntities } from "./model.ts";

type FacetCount = KbBrowseDTO["genres"][number];
/** A `<Link search>` updater: the current URL state in, the next one out. */
type Patch = (value: string | undefined) => (s: KbSearch) => KbSearch;

const CHIP = "font-mono [&_small]:ml-[5px] [&_small]:text-[11px] [&_small]:opacity-70";

export function KbPage() {
  usePageTitle("知识库");
  const search = kbRoute.useSearch();
  const { q } = kbRoute.useRouteContext();
  const { data } = useSuspenseQuery(q.kbBrowse(search));
  const navigate = useNavigate();

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // `FormData.get` widens to `File`; a `<input type="search">` can only be a string.
    const raw = new FormData(event.currentTarget).get("q");
    const text = typeof raw === "string" ? raw.trim() : "";
    // The KB box is the ranked endpoint scoped to KB text, not a facet filter.
    void navigate({ to: "/search", search: { q: text, scope: "kb" } });
  };

  const cards = data.cards;
  // `roundRobin` is generic over lists, so the card each pitfall came from is
  // paired in before the interleave — the feed needs both to link back.
  const pitfalls = roundRobin(
    cards.map((card) => card.pitfalls.map((text) => ({ card, text }))),
    PITFALL_LIMIT,
  );
  const tallies = countEntities(cards);
  const { common, rest } = splitEntities(tallies);

  return (
    <div className="page [--measure:1120px]">
      <h1 className="page-title">知识库</h1>
      <p className="max-w-[64rem] leading-[1.75] text-ink-2">
        每篇文章的 AI
        概览同时提取一份结构化条目：结论、成熟度、用到的型号与库、带单位的参数、作者做过的取舍和踩过的坑。
        这里按体裁、领域和兵种筛选；下面汇总当前这些文章的踩坑与出现最多的条目，点开一个条目可跨队伍对比。
      </p>

      <form
        className="mt-4 mb-1 flex max-w-[560px] gap-2 max-md:max-w-none"
        onSubmit={onSearch}
        role="search"
      >
        <Input
          type="search"
          name="q"
          className="bg-surface"
          defaultValue={search.q ?? ""}
          placeholder="搜知识库：EtherCAT、卡弹、CAN FD、减速比…"
          aria-label="搜索知识库"
          autoComplete="off"
        />
        <Button type="submit">搜索</Button>
      </form>

      <div className="mt-5 mb-1 flex flex-col gap-2">
        <FacetRow
          lead="体裁"
          items={data.genres}
          current={search.genre}
          patch={(genre) => (s) => ({ ...s, genre })}
        />
        <FacetRow
          lead="领域"
          items={data.domains}
          current={search.domain}
          patch={(domain) => (s) => ({ ...s, domain })}
        />
        <FacetRow
          lead="兵种"
          items={data.robotTypes}
          current={search.robot}
          patch={(robot) => (s) => ({ ...s, robot })}
        />
      </div>

      <p className="meta mt-2.5">当前筛选：{data.total} 篇文章</p>

      <div className="mt-3.5 grid grid-cols-1 items-start gap-7 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-12">
        {/* First in the DOM (it is the page's teaser), right rail on wide screens:
            grid placement, not `order`, so a narrow screen reads in DOM order. */}
        <aside
          className="flex flex-col gap-6 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:[scrollbar-width:thin]"
          aria-label="汇总"
        >
          {pitfalls.length > 0 && (
            <section>
              <h2 className="eyebrow m-0 mb-2.5">踩坑速览</h2>
              <ul className="flex flex-col gap-3 text-[13.5px] leading-relaxed text-ink-2">
                {pitfalls.map(({ card, text }, i) => (
                  <li className="border-l-2 border-warn pl-3" key={`${card.articleId}-${i}`}>
                    {text}
                    <Link
                      className="mt-0.5 block font-mono text-[11.5px] text-muted-foreground hover:text-accent"
                      to="/articles/$id"
                      params={{ id: card.articleId }}
                    >
                      {card.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {common.length > 0 && (
            <section>
              <h2 className="eyebrow m-0 mb-2.5">常见条目</h2>
              <div className="flex flex-wrap gap-1.5">
                {common.map((e) => (
                  <Badge variant="outline" className={CHIP} key={e.name} asChild>
                    <Link to="/kb/$name" params={{ name: e.name }}>
                      {e.name}
                      <small>{e.count}</small>
                    </Link>
                  </Badge>
                ))}
              </div>
            </section>
          )}
          {rest.length > 0 && (
            <Disclosure
              title={
                <>
                  全部条目<small className="ml-[5px] text-[11px]">{tallies.length}</small>
                </>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {rest.map((e) => (
                  <Badge variant="outline" className={CHIP} key={e.name} asChild>
                    <Link to="/kb/$name" params={{ name: e.name }}>
                      {e.name}
                    </Link>
                  </Badge>
                ))}
              </div>
            </Disclosure>
          )}
        </aside>

        <ol className="flex flex-col lg:col-start-1 lg:row-start-1">
          {cards.length === 0 && <li className="py-6 text-muted-foreground">没有匹配的条目</li>}
          {cards.map((card) => (
            <Card key={card.articleId} card={card} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function FacetRow({
  lead,
  items,
  current,
  patch,
}: {
  lead: string;
  items: readonly FacetCount[];
  current: string | undefined;
  patch: Patch;
}) {
  // A stale filter with no cards left still needs its chip, or it cannot be cleared.
  if (items.length === 0 && !current) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="eyebrow min-w-[3em]">{lead}</span>
      {items.map((item) => {
        const active = current === item.name;
        return (
          <Badge
            variant={active ? "default" : "outline"}
            className={`${CHIP} px-2.5 py-1 text-[13px]`}
            key={item.name}
            asChild
          >
            <Link
              to="/kb"
              // Clicking the active chip clears the axis: the chip is the toggle.
              search={patch(active ? undefined : item.name)}
              aria-current={active ? "true" : undefined}
            >
              {item.name}
              <small>{item.count}</small>
            </Link>
          </Badge>
        );
      })}
    </div>
  );
}

function Card({ card }: { card: KbCardDTO }) {
  // Cards carry the raw forum title (no `titleParts` on the KB wire), so it is shown as-is.
  const entities = card.entities.slice(0, 6);
  return (
    <li className="grid gap-1.5 border-t border-line-2 py-[18px]">
      <h2 className="m-0 font-body text-base leading-[1.4] font-semibold [&_a]:text-ink [&_a:hover]:text-accent">
        <Link to="/articles/$id" params={{ id: card.articleId }}>
          {card.title}
        </Link>
      </h2>
      <KbCardBody card={card} />
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {card.genre && (
          <Badge variant="outline" className={CHIP} asChild>
            <Link to="/kb" search={(s) => ({ ...s, genre: card.genre })}>
              {card.genre}
            </Link>
          </Badge>
        )}
        {card.domain.map((d) => (
          <Badge variant="outline" className={CHIP} key={`d-${d}`} asChild>
            <Link to="/kb" search={(s) => ({ ...s, domain: d })}>
              {d}
            </Link>
          </Badge>
        ))}
        {card.robotTypes.map((r) => (
          <Badge variant="outline" className={CHIP} key={`r-${r}`} asChild>
            <Link to="/kb" search={(s) => ({ ...s, robot: r })}>
              {r}
            </Link>
          </Badge>
        ))}
        {entities.length > 0 && <span className="h-3.5 w-px bg-line" aria-hidden="true" />}
        {entities.map((e) => (
          <Badge variant="outline" className={CHIP} key={`e-${e}`} asChild>
            <Link to="/kb/$name" params={{ name: e }}>
              {e}
            </Link>
          </Badge>
        ))}
      </div>
    </li>
  );
}
