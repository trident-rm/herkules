/**
 * Smoke renders for the shell's router-free leaves. `createElement` rather than
 * JSX because the package's vitest include is `web/tests/**\/*.test.ts` — a `.tsx`
 * file would not be collected at all.
 *
 * NOT covered here: App, AccountChip, RouteError, NotFound, TagsPage, AboutPage
 * and AccountPage's own panels — every one of them renders a `<Link>` or a route
 * hook, neither of which works outside a RouterProvider.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { LibraryStatusDTO } from "../../src/api/dto.ts";
import { loginErrorText } from "../src/account/loginError.ts";
import { FeedSkeleton, ReaderSkeleton } from "../src/shell/Skeletons.tsx";

import { StatusTiles } from "../src/status/StatusTiles.tsx";

/**
 * `__PUBLIC_ORIGIN__` is a build-time `define` from web/vite.config.ts, which the
 * package's own test config does not apply, and McpGuide reads it at import time.
 * Standing it up as a global first, then importing dynamically, is what makes that
 * module loadable here — a static import would be evaluated before the assignment.
 */
(globalThis as Record<string, unknown>).__PUBLIC_ORIGIN__ = "https://herkules.dev";
const { McpGuide } = await import("../src/account/McpGuide.tsx");

const STATUS: LibraryStatusDTO = {
  site: { name: "RoboMaster 论坛", url: "https://bbs.robomaster.com" },
  articles: { total: 1200, fetched: 1180, skipped: 20, tags: 340, images: 5600, links: 900 },
  ai: { ready: 1100, missing: 80, entities: 420 },
  crawler: {
    lastCheckedAt: "2026-08-27T02:30:00.000Z",
    lastCheckedAgeSeconds: 3600,
    backfillCompletedAt: "2026-05-01T00:00:00.000Z",
  },
  bot: { lastReconciledAt: null, lastReconciledAgeSeconds: null },
  importedAt: "2026-08-28T01:00:00.000Z",
};

describe("StatusTiles", () => {
  const html = renderToString(createElement(StatusTiles, { status: STATUS }));

  it("shows the three tiles' headline numbers", () => {
    expect(html).toContain("文库");
    expect(html).toContain("1180");
    expect(html).toContain("AI 概览");
    expect(html).toContain("1100");
    expect(html).toContain("抓取");
  });

  it("prints crawler dates in Asia/Shanghai", () => {
    expect(html).toContain("2026-08-27"); // 02:30 UTC is the same day in +08:00
    expect(html).toContain("已于 2026-05-01 完成");
  });

  it("says so when the backfill never finished", () => {
    const open = renderToString(
      createElement(StatusTiles, {
        status: {
          ...STATUS,
          crawler: { lastCheckedAt: null, lastCheckedAgeSeconds: null, backfillCompletedAt: null },
        },
      }),
    );
    expect(open).toContain("尚未完成");
    expect(open).toContain("—"); // NO_DATE keeps the tile's shape
  });
});

describe("McpGuide", () => {
  const html = renderToString(createElement(McpGuide));

  it("prints the claude mcp add line against the platform origin", () => {
    expect(html).toContain("claude mcp add --transport http rm-wenku");
    expect(html).toContain("https://herkules.dev/mcp/bbs");
  });

  it("covers every documented client and the Copilot CLI stopgap", () => {
    for (const client of [
      "Claude Code",
      "Cursor",
      "VS Code",
      "Codex",
      "Zed",
      "Gemini CLI",
      "GitHub Copilot CLI",
    ]) {
      expect(html).toContain(client);
    }
    expect(html).toContain("codex mcp login rm-wenku");
    expect(html).toContain(".cursor/mcp.json");
    expect(html).toContain(".vscode/mcp.json");
    expect(html).toContain("&quot;context_servers&quot;");
    expect(html).toContain("gemini mcp add --transport http --scope user rm-wenku");
    expect(html).toContain("/mcp auth rm-wenku");
    expect(html).toContain("https://herkules.dev/dev-token"); // the only manual-token path
  });
});

describe("login error banner text", () => {
  it("maps a known code, defaults an unknown one, and stays silent with none", () => {
    expect(loginErrorText("invalid_state")).toBe("登录已过期，请重试。");
    expect(loginErrorText("access_denied")).toBe("登录失败。");
    expect(loginErrorText(undefined)).toBeUndefined();
  });
});

describe("skeletons", () => {
  it("mark themselves busy", () => {
    expect(renderToString(createElement(FeedSkeleton))).toContain('aria-busy="true"');
    expect(renderToString(createElement(ReaderSkeleton))).toContain('aria-busy="true"');
  });
});
