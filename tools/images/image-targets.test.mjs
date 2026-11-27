import assert from "node:assert/strict";
import test from "node:test";
import { selectImageTargets } from "./image-targets.mjs";
test("shared UI affects every browser image", () => {
  assert.deepEqual(selectImageTargets(["packages/ui/src/button.tsx"]).targets, [
    "bbs",
    "bbs-web",
    "ai",
    "platform",
  ]);
});
test("application routes travel with the platform artifact", () => {
  assert.deepEqual(selectImageTargets(["tools/images/caddy/mcp/bbs.caddy"]).targets, ["platform"]);
});
test("public Markdown files are image inputs", () => {
  assert.deepEqual(selectImageTargets(["services/web/public/help.md"]).targets, ["platform"]);
});
test("documentation and infrastructure do not build application images", () => {
  assert.deepEqual(selectImageTargets(["README.md", "tools/deploy/Caddyfile"]).targets, []);
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
      javascript: false,
      rust: ["herkules-ai"],
    });
  }
});

test("BBS native and Feishu transport changes keep the BBS images paired", () => {
  assert.deepEqual(selectImageTargets(["apps/bbs/rust/src/http.rs"]).targets, ["bbs", "bbs-web"]);
  assert.deepEqual(selectImageTargets(["packages/feishu-rust/src/lib.rs"]), {
    targets: ["bbs", "bbs-web"],
    deploy: true,
    javascript: false,
    rust: ["herkules-bbs", "herkules-feishu"],
  });
});

test("contract vectors run both language checks without publishing images", () => {
  assert.deepEqual(selectImageTargets(["docs/tokens-vectors.json"]), {
    targets: [],
    deploy: false,
    javascript: true,
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
    assert.deepEqual(selectImageTargets([path]).targets, ["ai"]);
  }
  assert.deepEqual(
    selectImageTargets(["services/ai/README.md", "services/ai/tests/setup.test.ts"]).targets,
    [],
  );
});
