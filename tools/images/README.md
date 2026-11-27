# Application image contract

The root Dockerfile publishes `auth`, `bbs`, `bbs-web`, `ai` and `platform`. CI on
`main` compares inputs against a previous successful publication and builds the
affected targets together. The `application` artifact carries their new digests
and reuses the previous digests for unchanged images. CI builds all five for a
manual publication or when it cannot recover the previous manifest.
Production promotion is a separate reviewed change in `herkules-infra`.

`platform` is an artifact-only image: `/srv` contains the built frontend and `/caddy`
contains `platform.caddy`, `bbs.caddy`, `ai.caddy`, and nested `mcp/*.caddy`.
`ai.caddy` belongs inside both AI hostname blocks; the gateway routes by `Host`.
Do not start it as a container. Infrastructure copies these paths into its own Caddy
image and imports the fragments inside the corresponding site blocks. Hostnames,
TLS, global options and common headers belong to infrastructure. Preserve these paths
as a versioned interface; coordinate an incompatible change before promotion.

`sh tools/images/caddy.test.sh` checks the actual fragments using the Caddy parser.
`vp run test:images` checks image-selection rules. Browser API response validation
remains covered by `services/web` tests; static-delivery tests belong to infrastructure.

CI scans introduced commits for secrets and runs the selector tests when its code
or workflow changes. JavaScript CI checks changed workspaces and their consumers,
including development dependencies used by integration tests. Changes inside a
workspace's tests check that workspace.
Rust CI formats, lints, and tests the selected crates in one Cargo build graph when
several crates are affected. Shared lockfiles and workspace configuration can select
every workspace for that language. Pull requests are
checked against their base. On `main`, CI includes pending changes since the
last successful image publication. See [contributor checks](../../CONTRIBUTING.md)
for local component checks, history scans and legacy BBS parity.

`bbs-web` is the Rust-only web runtime (nonroot Rust PID 1, static Vite frontend,
no Node); its `bot` command runs the Rust Feishu bot and its `work` command runs the Rust crawler without an HTTP listener or auth configuration. Worker and bot deployments must override the web HTTP healthcheck; use status
freshness monitoring for both. `bbs` remains the Node jobs/migration image and hybrid rollback target.
The manifest records separate `bbs` and `bbs-web` digests. Infrastructure promotes
them together and can still read older manifests that omit `bbs-web`.
Both images carry the same frontend build under `/app/dist/client`.

CI builds `bbs` and `bbs-web` together and tests the exact digests with
`bbs-web.test.sh` and disposable Postgres before emitting the promotion manifest.
Production Compose runs schema preparation before starting the Rust web service.

`ai` is the AI gateway and portal (`services/ai`): one Rust binary as PID 1, nonroot,
with the Vite-built portal under `/app/dist/client`. It applies its own migrations to its
own database at start and listens on port 4010. The AI and BBS binary stages
compile separately. Changes to shared Rust auth code or the Cargo lockfile select both.
