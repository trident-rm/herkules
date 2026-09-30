import assert from "node:assert/strict";
import test from "node:test";
import { selectImageTargets } from "./image-targets.mjs";
test("shared UI affects both browser images", () => {
  assert.deepEqual(selectImageTargets(["packages/ui/src/button.tsx"]).targets, [
    "bbs",
    "bbs-web",
    "platform",
  ]);
});
test("application routes travel with the platform artifact", () => {
  assert.deepEqual(selectImageTargets(["tools/images/caddy/mcp/bbs.caddy"]).targets, ["platform"]);
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
test("docs and license changes do not require images; AI source does", () => {
  assert.equal(
    selectImageTargets(["docs/auth.md", "LICENSE-MIT", "KNOWN_ISSUES.md"]).deploy,
    false,
  );
  assert.deepEqual(selectImageTargets(["services/inference/src/gateway.ts"]).targets, ["ai"]);
});

test("training lessons, widgets and tooling rebuild the platform artifact", () => {
  for (const path of [
    "apps/training/docs/labs/pid.md",
    "apps/training/docs/.vitepress/config.mts",
    "apps/training/src/simulation.ts",
    "apps/training/package.json",
  ]) {
    assert.deepEqual(selectImageTargets([path]).targets, ["platform"]);
  }
  assert.deepEqual(selectImageTargets(["apps/training/README.md"]).targets, []);
});

test("Rust backend and shared auth changes rebuild the BBS runtime", () => {
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "apps/bbs/rust/src/http.rs",
    "packages/auth-rust/src/session.rs",
  ]) {
    assert.deepEqual(selectImageTargets([path]).targets, ["bbs", "bbs-web"]);
  }
});
