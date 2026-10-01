# Application image contract

The root Dockerfile publishes `auth`, `bbs`, `bbs-web`, `ai` and `platform`. After all checks
pass, CI builds all five in one shared BuildKit graph when image inputs change
(or on a manual run), then emits the `application` artifact.
Production promotion is a separate reviewed change in `herkules-infra`.

`platform` is an artifact-only image: `/srv` contains the built frontend and `/caddy`
contains `platform.caddy`, `bbs.caddy`, `ai.caddy`, `training.caddy`, and nested `mcp/*.caddy`.
Training static output lives under `/srv/training` and is served on its own origin.
Do not start it as a container. Infrastructure copies these paths into its own Caddy
image and imports the fragments inside the corresponding site blocks. Hostnames,
TLS, global options and common headers belong to infrastructure. Preserve these paths
as a versioned interface; coordinate an incompatible change before promotion.

`sh tools/images/caddy.test.sh` checks the actual fragments using the Caddy parser.
`training.test.sh` (also called by `caddy.test.sh`) checks clean lesson URLs, 404 status
and caching against the actual training fragment.
`vp run test:images` checks image-selection rules. Browser API response validation
remains covered by `services/web` tests; static-delivery tests belong to infrastructure.

Documentation-only changes still run checks, but skip image publication.

`bbs-web` is the Rust-only web runtime (nonroot Rust PID 1, static Vite frontend,
no Node); its `work` command runs the Rust crawler without an HTTP listener or auth configuration. Worker deployments must disable the web HTTP healthcheck. `bbs` remains the Node jobs/migration image and hybrid rollback target.
The new digest is emitted as `images["bbs-web"]` in `application.json`; infrastructure
must accept this optional fifth image before promoting a new manifest. Older
four-image manifests remain usable through infrastructure's legacy fallback.
Both images carry the same frontend build under `/app/dist/client`.

Before publication, CI builds the actual `bbs` and `bbs-web` images and runs
`bbs-web.test.sh` with disposable Postgres. Schema preparation must finish before
starting the Rust web service. Production Compose sequencing belongs to infrastructure.
