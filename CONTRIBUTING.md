# Contributor checks

Run `vp install` after checkout and read the README for the workspace you changed.
For AI and BBS, prek 0.5.11 or newer runs the same component hooks CI uses.
Run the applicable commands from the repository root.

```sh
prek run --hook-stage manual --all-files services/ai:build-js services/ai:check-js services/ai:test-js
prek run --hook-stage manual --all-files apps/bbs:build-js apps/bbs:check-js apps/bbs:test-js
prek run --hook-stage manual --all-files services/ai:rust
prek run --hook-stage manual --all-files apps/bbs:rust
```

The Rust hooks require the workspace's Rust toolchain with rustfmt and Clippy.
BBS also requires `protoc`. Developers using `mbx` can run the Cargo commands
from the component's `prek.toml` through `mbx`. For other JavaScript workspaces,
use their `vp` commands. Run `vp run ready` for full local validation.

## Additional checks

- Run `vp run test:images` when changing the CI selector or its workflow.
- Before publishing retained history or changing the secret-scan exceptions, run
  the [full-history Gitleaks audit](docs/public-release.md#repeat-the-local-scan).
  For staged changes, run `gitleaks git --staged --redact` before committing.
- For changes that affect legacy BBS parity, use the Postgres comparisons in the
  [BBS Rust README](apps/bbs/rust/README.md) or run CI manually with the `parity` option.
