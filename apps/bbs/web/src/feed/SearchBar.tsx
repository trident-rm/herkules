import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import type { FeedSearch } from "../url.ts";

type Scope = FeedSearch["scope"];

/**
 * `<Link>` decides "active" on its own and stamps `aria-current="page"` on the
 * winner (overriding ours); with the default PARTIAL search comparison a link
 * whose search is a subset of the URL's (全部, or a tab without `tag`) is active
 * too, so two entries would read as current. Exact comparison makes the router
 * agree with the explicit `aria-current` below; the CSS keys on the attribute's
 * presence, whichever of the two wrote it.
 */
export const EXACT = { exact: true } as const;

const SCOPES: readonly { value: Scope; label: string; title: string }[] = [
  { value: "title", label: "标题", title: "只搜索标题" },
  { value: "all", label: "全文", title: "搜索正文、简介与作者" },
  { value: "kb", label: "知识库", title: "搜索 AI 提取的型号、参数、取舍与踩坑" },
];

/**
 * The scope switch. Links rather than buttons: scope is URL state, so switching
 * it must be back-buttonable and preloadable like every other filter. `on` is
 * the CURRENT route — the switch never moves the reader between `/` and `/search`.
 */
export function ScopeLinks({ scope, on }: { scope: Scope; on: "/" | "/search" }) {
  return (
    <div
      className="flex flex-none overflow-hidden rounded-md border border-line bg-surface max-md:flex-auto"
      role="group"
      aria-label="搜索范围"
    >
      {SCOPES.map((item) => (
        <Button
          asChild
          variant="ghost"
          key={item.value}
          className="h-[42px] rounded-none px-4 text-muted-foreground hover:bg-transparent hover:text-ink aria-[current]:bg-accent aria-[current]:text-accent-ink max-md:flex-1 [&+a]:border-l [&+a]:border-line"
        >
          <Link
            to={on}
            activeOptions={EXACT}
            title={item.title}
            search={(s) => ({ ...s, scope: item.value })}
            aria-current={scope === item.value ? "true" : undefined}
          >
            {item.label}
          </Link>
        </Button>
      ))}
    </div>
  );
}

/**
 * The query box. `value` is the URL's `q`; the field is local state synced from
 * it in an effect (never during render, so typing keeps focus and React never
 * sees a write mid-render).
 */
export function SearchBar({
  value,
  scope,
  to,
}: {
  value: string;
  scope: Scope;
  to: "/search" | "/";
}) {
  const navigate = useNavigate();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (to === "/search") {
      // A blank ranked search is the feed with the same filters (the route redirects too).
      if (!q) void navigate({ to: "/", search: (s) => ({ ...s, q: undefined }) });
      else void navigate({ to: "/search", search: (s) => ({ ...s, q, scope }) }); // tag/group ride along
      return;
    }
    void navigate({ to: "/", search: (s) => ({ ...s, q: q || undefined }) });
  }

  return (
    <form className="flex min-w-0 flex-[1_1_420px] gap-2" role="search" onSubmit={submit}>
      <Input
        type="search"
        name="q"
        className="h-11 bg-surface px-3.5"
        aria-label="搜索文章"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="搜索：自瞄、飞镖、成本控制、TensorRT…"
        autoComplete="off"
      />
      <Button type="submit" className="h-11">
        搜索
      </Button>
    </form>
  );
}
