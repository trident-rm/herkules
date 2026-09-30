import { Card } from "@herkules/ui/components/card";
/**
 * The status numbers, with no router and no query — its own module so a test can
 * render it from a fixture DTO without pulling `routes.tsx` (and with it every
 * screen) into the module graph.
 */
import type { LibraryStatusDTO } from "../../../src/api/dto.ts";
import { formatDate } from "../lib/format.ts";

/** The import stamp is the one place a day is too coarse: it answers "how fresh is this?". */
const STAMP = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});

export function stampText(iso: string | null): string {
  if (!iso) return "未知时间";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "未知时间" : STAMP.format(ms);
}

const TILE =
  "flex min-w-0 flex-col gap-[0.4rem] rounded-lg border border-line bg-surface px-[1.1rem] py-4";
const BIG =
  "flex flex-wrap items-baseline gap-2 text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] tabular-nums";

export function StatusTiles({ status }: { status: LibraryStatusDTO }) {
  const { articles, ai, crawler } = status;
  return (
    <div className="my-5 mb-4 grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="进度概览">
      <Card className={`${TILE} shadow-none`}>
        <span className="eyebrow">文库</span>
        <span className={BIG}>
          {articles.fetched}
          <small className="text-[0.8rem] font-normal text-muted-foreground">篇正文</small>
        </span>
        <span className="meta">
          共 {articles.total} 篇 · 跳过 {articles.skipped}
          <br />
          标签 {articles.tags} · 图 {articles.images} · 链接 {articles.links}
        </span>
      </Card>
      <Card className={`${TILE} shadow-none`}>
        <span className="eyebrow">AI 概览</span>
        <span className={BIG}>
          {ai.ready}
          <small className="text-[0.8rem] font-normal text-muted-foreground">篇已生成</small>
        </span>
        <span className="meta">
          待生成 {ai.missing}
          <br />
          知识库条目 {ai.entities}
        </span>
      </Card>
      <Card className={`${TILE} shadow-none`}>
        <span className="eyebrow">抓取</span>
        <span className={BIG}>
          {formatDate(crawler.lastCheckedAt)}
          <small className="text-[0.8rem] font-normal text-muted-foreground">最近检查</small>
        </span>
        <span className="meta">
          历史回填{" "}
          {crawler.backfillCompletedAt
            ? `已于 ${formatDate(crawler.backfillCompletedAt)} 完成`
            : "尚未完成"}
          <br />
          抓取仍在原服务器上运行
        </span>
      </Card>
    </div>
  );
}
