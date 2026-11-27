# Deployment

Production infrastructure lives in the private repository [herkules-infra](https://github.com/trident-rm/herkules-infra).
The [runbook](https://github.com/trident-rm/herkules-infra/blob/main/tools/deploy/README.md)
owns Terraform, Compose, routing, monitoring, backups, deployment and rollback.
These links require infrastructure-repository access; application development and
tests can run from this public repository alone.

On `main`, CI builds the affected `auth`, `bbs`, `bbs-web`, `ai`, and `platform`
targets after the relevant checks pass. The `application` artifact (`application.json`)
contains the new immutable references and carries forward unchanged images from a
previous successful build. A manual run can rebuild all targets.
Infrastructure can select the entire manifest or promote a component in a reviewed commit.
Application CI has no VPS or Cloudflare deployment credentials.

The `platform` artifact contains `/srv` (the platform frontend) and `/caddy`
(application route fragments from `tools/images/caddy`). Infrastructure owns the Caddy
runtime, TLS, hostnames and trusted proxies, and imports those fragments inside its
site blocks. Both fragments and assets come from the same selected image digest.

Normal local development remains `vp run dev`; no infrastructure checkout is required.
See the infrastructure repository's `MIGRATION.md` for the initial ownership transfer.

BBS has separate digests for the web image and the jobs image that prepares its
database. Promote them together with `--only bbs` in the infrastructure repository.
