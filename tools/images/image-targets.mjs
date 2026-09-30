import { pathToFileURL } from "node:url";

const allTargets = ["auth", "bbs", "ai", "platform"];
const nodeBuildInputs = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vite.config.ts",
]);
export function selectImageTargets(paths, { all = false } = {}) {
  if (all) return { targets: allTargets, deploy: true };

  const targets = new Set();
  let deploy = false;
  const add = (...names) => names.forEach((name) => targets.add(name));

  for (const path of paths) {
    if (!path) continue;
    if (path === "README.md" || path.endsWith("/README.md")) continue;
    if (path.startsWith("tools/images/caddy/")) add("platform");
    if (
      path.startsWith(".github/workflows/") ||
      path === "tools/images/image-targets.mjs" ||
      ["Dockerfile", ".dockerignore", "tools/images/docker-bake.hcl"].includes(path)
    )
      add(...allTargets);
    if (
      ["Cargo.toml", "Cargo.lock"].includes(path) ||
      path.startsWith("apps/bbs/rust/") ||
      path.startsWith("packages/auth-rust/")
    )
      add("bbs");
    if (nodeBuildInputs.has(path) || path.startsWith("tsconfig")) add(...allTargets);
    if (isBuildInput(path, "services/feishu", ["src"])) add("auth");
    if (isBuildInput(path, "services/auth", ["src", "drizzle"])) add("auth");
    if (
      isBuildInput(path, "services/inference", ["src"]) ||
      path.startsWith("tools/ai/portal/") ||
      path.startsWith("tools/ai/new-api/")
    )
      add("ai");
    if (isBuildInput(path, "services/web", ["src", "public"])) add("platform");
    if (isBuildInput(path, "apps/training", ["docs", "src"])) add("platform");
    if (isBuildInput(path, "apps/bbs", ["src", "drizzle", "web/src", "web/public"])) add("bbs");
    if (isBuildInput(path, "packages/auth-middleware", ["src"])) add("auth", "bbs");
    if (isBuildInput(path, "packages/oauth-client", ["src"])) add("bbs");
    if (isBuildInput(path, "packages/ui", ["src"])) add("bbs", "platform");
  }

  const selected = allTargets.filter((target) => targets.has(target));
  return { targets: selected, deploy: deploy || selected.length > 0 };
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
