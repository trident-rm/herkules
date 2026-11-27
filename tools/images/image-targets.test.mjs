import assert from "node:assert/strict";
import test from "node:test";
import { selectImageTargets } from "./image-targets.mjs";
test("shared UI affects every browser image", () => {
  const selection = selectImageTargets(["packages/ui/src/button.tsx"]);
  assert.deepEqual(selection.targets, ["bbs", "bbs-web", "ai", "platform"]);
  assert.deepEqual(selection.javascript, ["...{./packages/ui}"]);
});
test("application routes travel with the platform artifact", () => {
  assert.deepEqual(selectImageTargets(["tools/images/caddy/mcp/bbs.caddy"]).targets, ["platform"]);
});
test("public Markdown files are image inputs", () => {
  assert.deepEqual(selectImageTargets(["services/web/public/help.md"]).targets, ["platform"]);
});
test("documentation and infrastructure do not build application images", () => {
  const selection = selectImageTargets(["README.md", "tools/deploy/Caddyfile"]);
  assert.deepEqual(selection.targets, []);
  assert.deepEqual(selection.javascript, []);
  assert.deepEqual(selection.rust, []);
});

test("lockfile and publication machinery invalidate the complete image tuple", () => {
  for (const path of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".dockerignore",
    ".github/workflows/image-build.yml",
    "tools/images/image-targets.mjs",
  ]) {
    assert.deepEqual(selectImageTargets([path]).targets, [
      "auth",
      "bbs",
      "bbs-web",
      "ai",
      "platform",
    ]);
  }
});
test("docs and license changes do not require images", () => {
  assert.equal(
    selectImageTargets(["docs/auth.md", "LICENSE-MIT", "KNOWN_ISSUES.md"]).deploy,
    false,
  );
});

test("local training changes do not trigger application images", () => {
  for (const path of [
    "apps/training/docs/labs/pid.md",
    "apps/training/docs/.vitepress/config.mts",
    "apps/training/src/simulation.ts",
    "apps/training/package.json",
  ]) {
    assert.deepEqual(selectImageTargets([path]).targets, []);
  }
  assert.deepEqual(selectImageTargets(["apps/training/README.md"]).targets, []);
});

test("shared Rust inputs rebuild both Rust runtimes", () => {
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "packages/auth-rust/src/session.rs",
    "services/ai/Cargo.toml",
  ]) {
    assert.deepEqual(selectImageTargets([path]).targets, ["bbs", "bbs-web", "ai"]);
  }
});

test("AI Rust changes build AI and run only its Rust checks", () => {
  for (const path of ["services/ai/src/api.rs", "services/ai/migrations/0001_init.sql"]) {
    assert.deepEqual(selectImageTargets([path]), {
      targets: ["ai"],
      deploy: true,
      javascript: [],
      rust: ["herkules-ai"],
    });
  }
});

test("BBS native and Feishu transport changes keep the BBS images paired", () => {
  assert.deepEqual(selectImageTargets(["apps/bbs/rust/src/http.rs"]).targets, ["bbs", "bbs-web"]);
  assert.deepEqual(selectImageTargets(["packages/feishu-rust/src/lib.rs"]), {
    targets: ["bbs", "bbs-web"],
    deploy: true,
    javascript: [],
    rust: ["herkules-bbs", "herkules-feishu"],
  });
});

test("contract vectors run both language checks without publishing images", () => {
  assert.deepEqual(selectImageTargets(["docs/tokens-vectors.json"]), {
    targets: [],
    deploy: false,
    javascript: ["./packages/auth-middleware"],
    rust: ["herkules-auth"],
  });
});

test("portal changes rebuild only the AI image", () => {
  for (const path of [
    "services/ai/web/src/App.tsx",
    "services/ai/web/index.html",
    "services/ai/web/vite.config.ts",
    "services/ai/package.json",
  ]) {
    const selection = selectImageTargets([path]);
    assert.deepEqual(selection.targets, ["ai"]);
    assert.deepEqual(selection.javascript, ["...{./services/ai}"]);
    assert.deepEqual(selection.rust, []);
  }
  assert.deepEqual(
    selectImageTargets(["services/ai/README.md", "services/ai/tests/setup.test.ts"]).targets,
    [],
  );
});

test("workspace-only tests do not select dependents", () => {
  assert.deepEqual(
    selectImageTargets(["services/auth/tests/flow.test.ts", "apps/bbs/web/tests/app.test.ts"])
      .javascript,
    ["./apps/bbs", "./services/auth"],
  );
});

test("Feishu is checked when its inherited auth config changes", () => {
  assert.deepEqual(selectImageTargets(["services/auth/tsconfig.json"]).javascript, [
    "...{./services/auth}",
    "./services/feishu",
  ]);
});

test("shared JavaScript inputs trigger full workspace checks", () => {
  assert.deepEqual(
    selectImageTargets(["pnpm-lock.yaml", "services/ai/web/src/App.tsx"]).javascript,
    ["."],
  );
  assert.deepEqual(selectImageTargets([], { all: true }).javascript, ["."]);
});

test("changes to component hook configs run their JavaScript and Rust checks without images", () => {
  for (const [root, crate] of [
    ["apps/bbs", "herkules-bbs"],
    ["services/ai", "herkules-ai"],
  ]) {
    const selection = selectImageTargets([`${root}/prek.toml`]);
    assert.deepEqual(selection.targets, []);
    assert.deepEqual(selection.javascript, [`...{./${root}}`]);
    assert.deepEqual(selection.rust, [crate]);
  }
  const shared = selectImageTargets(["prek.toml"]);
  assert.deepEqual(shared.targets, []);
  assert.deepEqual(shared.javascript, ["."]);
  assert.deepEqual(shared.rust, selectImageTargets([], { all: true }).rust);
});
