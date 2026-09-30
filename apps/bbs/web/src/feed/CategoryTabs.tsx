import { Button } from "@herkules/ui/components/button";
import { Badge } from "@herkules/ui/components/badge";
import { Link } from "@tanstack/react-router";

import type { TagIndexDTO } from "../../../src/api/dto.ts";
import type { FeedSearch } from "../url.ts";
import { leafOf } from "../url.ts";
import { EXACT } from "./SearchBar.tsx";

/**
 * 群组 tabs with a sub-tag chip row. Counts come from `q.tags()`; a group's
 * count is COUNT(DISTINCT article), not the sum of its tags'. `q` and `scope`
 * ride along (the updater keeps them) so filtering never drops the query.
 */
const TAB =
  "relative flex items-baseline gap-[7px] px-0.5 py-2.5 text-[15px] whitespace-nowrap text-muted-foreground hover:text-ink hover:no-underline aria-[current]:font-medium aria-[current]:text-ink aria-[current]:after:absolute aria-[current]:after:inset-x-0 aria-[current]:after:-bottom-px aria-[current]:after:h-0.5 aria-[current]:after:bg-accent aria-[current]:after:content-['']";
const N = "font-mono text-xs text-muted-foreground";

export function CategoryTabs({ tags, search }: { tags: TagIndexDTO; search: FeedSearch }) {
  const { group, tag } = search;
  const subTags = group ? tags.items.filter((t) => t.name.startsWith(`${group}/`)) : [];

  return (
    <section className="mt-[22px]" aria-label="分类">
      <div className="flex gap-[26px] overflow-x-auto border-b border-line [scrollbar-width:none]">
        <Button
          asChild
          variant="ghost"
          className={`${TAB} h-auto rounded-none hover:bg-transparent`}
        >
          <Link
            to="/"
            activeOptions={EXACT}
            search={(s) => ({ ...s, group: undefined, tag: undefined })}
            aria-current={group === undefined ? "true" : undefined}
          >
            全部 <span className={N}>{tags.total}</span>
          </Link>
        </Button>
        {tags.groups.map((g) => (
          <Button
            asChild
            variant="ghost"
            className={`${TAB} h-auto rounded-none hover:bg-transparent`}
            key={g.name}
          >
            <Link
              to="/"
              activeOptions={EXACT}
              search={(s) => ({ ...s, group: g.name, tag: undefined })}
              aria-current={group === g.name ? "true" : undefined}
            >
              {g.name} <span className={N}>{g.count}</span>
            </Link>
          </Button>
        ))}
      </div>
      {group !== undefined && subTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <span className="eyebrow">{group} /</span>
          <Badge variant={tag === undefined ? "default" : "outline"} className="font-mono" asChild>
            <Link
              to="/"
              activeOptions={EXACT}
              search={(s) => ({ ...s, group, tag: undefined })}
              aria-current={tag === undefined ? "true" : undefined}
            >
              全部
            </Link>
          </Badge>
          {subTags.map((t) => (
            <Badge
              key={t.name}
              variant={tag === t.name ? "default" : "outline"}
              className="font-mono"
              asChild
            >
              <Link
                to="/"
                activeOptions={EXACT}
                search={(s) => ({ ...s, group, tag: t.name })}
                aria-current={tag === t.name ? "true" : undefined}
                title={`${t.count} 篇`}
              >
                {leafOf(t.name)} <span className="opacity-70">{t.count}</span>
              </Link>
            </Badge>
          ))}
        </div>
      )}
    </section>
  );
}
