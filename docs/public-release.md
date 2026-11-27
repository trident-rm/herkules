# Public release record

The application repository became public on 2026-09-19 (Hong Kong time), with Git
history retained. Production infrastructure remains in the private
`herkules-infra` repository. Historical application commits still contain former
infrastructure paths, production topology, and operational notes.

## Publication review

Before the visibility change, the review covered:

- 259 commits across fetched branches and retained pull-request heads, scanned
  with Gitleaks 8.30.1 and the repository's documented exceptions.
- 260 retained Actions run logs and 216 artifact bundles, including compressed
  build records, scanned with archive and encoded-content inspection enabled.
- Issue and pull-request bodies, issue comments, and review comments. No releases
  or attachment links were found in the reviewed content.
- Exact-value checks for seven local credential values against downloaded hosted
  content; none matched.

The scans found no credentials. Three hosted-content findings were checked and
identified as a public encryption key (in two log files) and a Cloudflare Access
audience identifier. The obsolete encrypted infrastructure-secret transfer artifact
was removed from GitHub after a private local copy was preserved.

This is a record of the checks performed, not proof that credentials were never
exposed. Automated scanners have blind spots, and the review does not certify
application security or cover deleted/unavailable content. Outstanding defects in
[`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) remain a separate backlog.

## Repository safeguards

- Original code is licensed under `MIT OR Apache-2.0`; third-party exceptions are
  recorded in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
- Workspace package metadata retains `private: true`. Source visibility does not
  publish npm packages or change container-package visibility.
- GitHub secret scanning and push protection are enabled, along with
  [private vulnerability reporting](../SECURITY.md).
- Fork pull-request workflow runs require approval for all outside contributors.
  The default Actions token is read-only; image publication runs only on `main`
  outside pull-request events. Application Actions store no production secrets.
- External Actions are pinned to commit hashes, with grouped Dependabot updates.
- CI scans introduced commits with checksum-pinned Gitleaks and redacted output.
  Tested application manifests require that scan and the build and test checks.
  Use the local audit below to scan all reachable refs.
- [`.gitleaks.toml`](../.gitleaks.toml) contains narrow exceptions for public test
  vectors, deterministic test credentials, a historical public encryption key,
  and a prose false positive. Review exception changes carefully.

Application CI publishes artifacts; production promotion is a separate change in
infrastructure. See [the deployment contract](deploy.md). Preserve rollback images
and release provenance when cleaning up historical artifacts or packages.

## Repeat the local scan

With Gitleaks 8.30.1 installed, run from the repository root:

```sh
gitleaks git --redact --log-opts="--all"
```

This scans locally available refs, not every GitHub pull-request ref or hosted log.
Fetch the refs needed for your review before scanning. For a current-tree audit,
scan a temporary export of tracked files instead of the working directory: ignored
local `.env` files are intentionally private. Never upload an unredacted report.

Keep credentials and server-owned `.env` files outside Git. If a real credential is
found, revoke or rotate it before considering history cleanup; rewriting a branch
does not remove copies in PR refs, logs, artifacts, or forks.

GitHub documents visibility-change effects in
[Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
