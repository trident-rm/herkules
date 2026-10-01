import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // The workspace's only lint/format config: every package inherits these
  // settings, so per-package vite.config.ts files carry no `lint`/`fmt` blocks.
  //
  // `.direnv/` is direnv's checkout of the repo flake into the nix store:
  // host-local material, not source. Linting it produced ~285 findings that
  // buried the nine the repo actually had, and it grows with every flake input.
  // `dist/` is build output for the same reason. Both are gitignored too, but
  // naming them here keeps the intent local instead of depending on that file.
  fmt: { ignorePatterns: [".direnv/**", "dist/**"] },
  lint: {
    ignorePatterns: [".direnv/**", "dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
    tasks: {
      "check:rust": {
        command:
          "cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings",
        cache: false,
      },
      "test:rust:bot": {
        command:
          "cargo build -p herkules-bbs --bin herkules-bbs --example bot_probe --example bot_worker_fixture --locked && node apps/bbs/scripts/rust-bot-parity.ts",
        cache: false,
      },
      "test:rust": { command: "cargo test --workspace --locked", cache: false },
      // The whole local stack without Docker, five processes at once:
      //   :3000  services/web   the PUBLIC origin; its Vite server proxies /auth and /.well-known
      //                         to :3001 and /mcp/bbs to bbs
      //   :3001  services/auth  the authorization server (PGlite, no postgres needed)
      //   :3003  apps/bbs SPA   bbs's APP origin; proxies /api, /login, /callback, /logout,
      //                         /healthz and /mcp to :3103
      //   :3004  apps/training VitePress course site
      //   :3103  apps/bbs Hono  the API, MCP and SPA host
      //
      // First run, once per checkout: copy each package's .env.example to .env
      // (services/auth, apps/bbs; services/web needs none), `mkdir -p apps/bbs/.data` — PGlite
      // does not create the parent directory — and load a corpus with
      // `vp run @herkules/bbs#import <path>/app.db`. The import is deliberately NOT part of this
      // task: it truncates the corpus, so it must stay something you type on purpose.
      //
      // Ctrl-C reaches all five: they share the task's process group. `wait` keeps the task
      // alive until the last one exits, so one crash does not silently take the others with it.
      dev: {
        command:
          "vp run @herkules/auth#dev & vp run @herkules/web#dev & vp run @herkules/bbs#dev & vp run @herkules/bbs#dev:web & vp run @herkules/training#dev & wait",
        cache: false,
      },
    },
  },
});
