import { pathToFileURL } from "node:url";

const allTargets = ["auth", "bbs", "bbs-web", "ai", "platform"];
const rustPackages = ["herkules-bbs", "herkules-ai", "herkules-auth", "herkules-feishu"];
const nodeBuildInputs = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vite.config.ts",
]);
export function selectImageTargets(paths, { all = false } = {}) {
  if (all) return { targets: allTargets, deploy: true, javascript: true, rust: rustPackages };

  const targets = new Set();
  const rust = new Set();
  let javascript = false;
  const add = (...names) => names.forEach((name) => targets.add(name));

  for (const path of paths) {
    if (!path) continue;
    if (path === "README.md" || path.endsWith("/README.md")) continue;
    const bbsRust = path.startsWith("apps/bbs/rust/");
    const feishuRust = path.startsWith("packages/feishu-rust/");
    const authRust = path.startsWith("packages/auth-rust/");
    const aiRust =
      path === "services/ai/Cargo.toml" ||
      path.startsWith("services/ai/src/") ||
      path.startsWith("services/ai/migrations/") ||
      (path.startsWith("services/ai/tests/") && path.endsWith(".rs"));
    const rustWorkspace = ["Cargo.toml", "Cargo.lock"].includes(path);
    const ciConfig = path.startsWith(".github/workflows/");
    const tokenVectors = path === "docs/tokens-vectors.json";
    if (
      ciConfig ||
      tokenVectors ||
      path.startsWith("tsconfig") ||
      nodeBuildInputs.has(path) ||
      (!bbsRust && !authRust && !feishuRust && !aiRust && /^(apps|packages|services)\//.test(path))
    )
      javascript = true;
    if (ciConfig || rustWorkspace) rustPackages.forEach((name) => rust.add(name));
    if (
      bbsRust ||
      feishuRust ||
      authRust ||
      path.startsWith("apps/bbs/tests/fixtures/title-parser/")
    )
      rust.add("herkules-bbs");
    if (aiRust || authRust) rust.add("herkules-ai");
    if (authRust || tokenVectors) rust.add("herkules-auth");
    if (feishuRust) rust.add("herkules-feishu");
    if (path.startsWith("tools/images/caddy/") || path === "tools/images/caddy.test.sh")
      add("platform");
    if (path === "tools/images/bbs-web.test.sh") add("bbs", "bbs-web");
    if (
      path === ".github/workflows/image-build.yml" ||
      path === "tools/images/image-targets.mjs" ||
      ["Dockerfile", ".dockerignore", "tools/images/docker-bake.hcl"].includes(path)
    )
      add(...allTargets);
    if (
      rustWorkspace ||
      authRust ||
      (path.endsWith("/Cargo.toml") && (aiRust || bbsRust || feishuRust))
    )
      add("bbs", "bbs-web", "ai");
    if (bbsRust || feishuRust) add("bbs", "bbs-web");
    if (aiRust && !path.startsWith("services/ai/tests/")) add("ai");
    if (isBuildInput(path, "services/ai", ["web/src", "web/public"])) add("ai");
    if (nodeBuildInputs.has(path) || path.startsWith("tsconfig")) add(...allTargets);
    if (isBuildInput(path, "services/feishu", ["src"])) add("auth");
    if (isBuildInput(path, "services/auth", ["src", "drizzle"])) add("auth");
    if (isBuildInput(path, "services/web", ["src", "public"])) add("platform");
    if (isBuildInput(path, "apps/bbs", ["src", "drizzle", "web/src", "web/public"]))
      add("bbs", "bbs-web");
    if (isBuildInput(path, "packages/auth-middleware", ["src"])) add("auth", "bbs", "bbs-web");
    if (isBuildInput(path, "packages/oauth-client", ["src"])) add("bbs", "bbs-web");
    if (isBuildInput(path, "packages/ui", ["src"])) add("bbs", "bbs-web", "ai", "platform");
  }

  const selected = allTargets.filter((target) => targets.has(target));
  return {
    targets: selected,
    deploy: selected.length > 0,
    javascript,
    rust: rustPackages.filter((name) => rust.has(name)),
  };
}

function isBuildInput(path, root, directories) {
  if (!path.startsWith(`${root}/`)) return false;
  if (directories.some((directory) => path.startsWith(`${root}/${directory}/`))) return true;

  const name = path.slice(root.length + 1);
  const parts = name.split("/");
  const leaf = parts.at(-1);
  const buildRoot = parts.length === 1 || (parts.length === 2 && parts[0] === "web");
  return (
    buildRoot &&
    (leaf === "package.json" ||
      leaf === "index.html" ||
      leaf === "components.json" ||
      leaf.startsWith("tsconfig") ||
      leaf.endsWith(".config.ts"))
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const all = process.argv.includes("--all");
  let input = "";
  if (!all) {
    for await (const chunk of process.stdin) input += chunk;
  }
  const paths = input.split("\n");
  process.stdout.write(`${JSON.stringify(selectImageTargets(paths, { all }))}\n`);
}
