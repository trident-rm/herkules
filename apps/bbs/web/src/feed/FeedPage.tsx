import { Button } from "@herkules/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { feedRoute } from "../routes.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";
import { ArticleRow } from "./ArticleRow.tsx";
import { CategoryTabs } from "./CategoryTabs.tsx";
import { LoadMore } from "./LoadMore.tsx";
import { ScopeLinks, SearchBar } from "./SearchBar.tsx";

/** `/` — the date-ordered feed. The loader already ensured both queries; no pending or error branch. */
export function FeedPage() {
  const search = feedRoute.useSearch();
  const { q } = feedRoute.useRouteContext();
  const { data: tags } = useSuspenseQuery(q.tags());
  const feed = useSuspenseInfiniteQuery(q.feed(search));
  usePageTitle(null);

  const { fetchNextPage } = feed;
  const items = useMemo(() => feed.data.pages.flatMap((page) => page.items), [feed.data]);
  // Stable: `LoadMore` re-creates its observer whenever this identity changes.
  const onMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  return (
    <div className="page">
      <div className="flex flex-wrap items-center gap-2.5 pt-2">
        <SearchBar value={search.q ?? ""} scope={search.scope} to="/search" />
        <ScopeLinks scope={search.scope} on="/" />
      </div>
      <CategoryTabs tags={tags} search={search} />
      {search.q && (
        <p className="meta flex items-baseline gap-2 pt-3">
          筛选：「{search.q}」
          <Button asChild variant="ghost" size="icon-sm">
            <Link to="/" search={(s) => ({ ...s, q: undefined })} aria-label="清除关键词">
              ×
            </Link>
          </Button>
        </p>
      )}
      {items.length === 0 ? (
        <p className="py-6 text-muted-foreground">没有匹配的文章</p>
      ) : (
        <div className="mt-4">
          {items.map((article) => (
            <ArticleRow key={article.id} article={article} />
          ))}
        </div>
      )}
      <LoadMore hasNext={feed.hasNextPage} isFetching={feed.isFetchingNextPage} onMore={onMore} />
    </div>
  );
}
