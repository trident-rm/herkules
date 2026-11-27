/**
 * The shell: header (wordmark, nav, theme toggle, account) + <Outlet/> + footer.
 * It never touches `document.title` — screens own that through `usePageTitle`,
 * so the server-injected <title> of a deep link survives the first paint.
 */
import { Link, Outlet } from "@tanstack/react-router";

import { AccountChip } from "./AccountChip.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

const NAV =
  "border-b-2 border-transparent py-0.5 text-muted-foreground transition-colors hover:text-ink hover:no-underline";
const ACTIVE = { className: "text-ink border-accent" };

export function App() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="page flex min-h-15 flex-wrap items-center gap-x-6 gap-y-3 py-2 md:flex-nowrap">
          <Link
            className="font-display text-[1.35rem] tracking-[0.01em] whitespace-nowrap text-ink hover:no-underline"
            to="/"
          >
            RM 文库
          </Link>
          <nav
            className="order-3 flex w-full min-w-0 items-center gap-4 overflow-x-auto text-sm [scrollbar-width:none] md:order-none md:ml-auto md:w-auto md:gap-[1.1rem] md:text-[0.9rem]"
            aria-label="站点导航"
          >
            {/* The feed is active on "/" only: every article link would otherwise
                light it up, and /search has its own entry point in the feed. */}
            <Link className={NAV} to="/" activeOptions={{ exact: true }} activeProps={ACTIVE}>
              文章
            </Link>
            <Link className={NAV} to="/kb" activeProps={ACTIVE}>
              知识库
            </Link>
            <Link className={NAV} to="/resources" activeProps={ACTIVE}>
              规则与资料
            </Link>
            <Link className={NAV} to="/tags" activeProps={ACTIVE}>
              标签
            </Link>
            <Link className={NAV} to="/status" activeProps={ACTIVE}>
              状态
            </Link>
            <Link className={NAV} to="/about" activeProps={ACTIVE}>
              关于
            </Link>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3 md:ml-0">
            <AccountChip />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-line font-mono text-[0.72rem] leading-[1.9] text-muted-foreground">
        <div className="page py-5 pb-7">
          <div>非官方归档 · 正文与图片版权归原作者与 RoboMaster 所有</div>
          <div>
            <Link to="/about">关于本站</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
