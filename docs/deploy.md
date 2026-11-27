# Deployment

Production infrastructure lives in the private repository [herkules-infra](https://github.com/trident-rm/herkules-infra).
The [runbook](https://github.com/trident-rm/herkules-infra/blob/main/tools/deploy/README.md)
owns Terraform, Compose, routing, monitoring, backups, deployment and rollback.
These links require infrastructure-repository access; application development and
tests can run from this public repository alone.

This repository builds `auth`, `bbs`, `bbs-web`, `ai`, and `platform` images as one shared
BuildKit graph after CI checks pass. When image inputs change on `main` (or a manual
run requests a build), CI publishes their immutable references as the `application`
artifact (`application.json`). Documentation-only changes skip image publication.
Infrastructure selects that manifest in a reviewed commit. Application CI has no VPS or
Cloudflare deployment credentials and does not change production.

The `platform` artifact contains `/srv` (the platform frontend) and `/caddy`
(application route fragments from `tools/images/caddy`). Infrastructure owns the Caddy
runtime, TLS, hostnames and trusted proxies, and imports those fragments inside its
site blocks. Both fragments and assets come from the same selected image digest.

Normal local development remains `vp run dev`; no infrastructure checkout is required.
See the infrastructure repository's `MIGRATION.md` for the initial ownership transfer.

The Rust-only BBS web image is selected separately from the existing Node `bbs`
image used for preparation, crawler and bot jobs. Its first promotion requires the
coordinated infrastructure manifest/Compose change; application publication alone
never replaces production services.
