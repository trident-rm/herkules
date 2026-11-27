# Herkules

The team's self-hosted identity layer and internal application monorepo. The workspace map is in `README.md`; cross-cutting contracts live in `docs/README.md`. Every workspace has its own README with run/test commands and binding decisions — read it before working in that workspace. Known defects and gaps that are found but deliberately unfixed are tracked in `KNOWN_ISSUES.md`; check it before re-auditing an area, and remove an entry there when you fix it.

## Commands

- `vp install` — after pulling remote changes
- `vp run dev` — the whole local stack: auth :3001, web :3000, bbs :3103 + :3003
- `vp run ready` — full local validation. CI selects language checks by changed inputs.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for local prek commands, the full-history secret audit, and on-demand BBS parity checks.
- `vp check` / `vp test` — format, lint, type-check / test the current workspace
- `vp run <pkg>#<script>` — a package script, e.g. `vp run @herkules/bbs#import <path>/app.db`

## Constraints

- Drizzle SQL under `apps/bbs/drizzle/` and `services/auth/drizzle/` is generated output — never hand-edit it. See `apps/bbs/drizzle/README.md` (includes the manual `pg_trgm` step after regeneration).
- `apps/bbs/web` is a deliberate second Vite root inside the `apps/bbs` package, not a workspace of its own.
- `packages/ui` ships source CSS/tsx directly and is never built.
- Lint and format settings live only in the root `vite.config.ts`; per-package configs carry only Vite/Vitest/pack settings.
- First checkout only: copy `.env.example` to `.env` in `services/auth` and `apps/bbs`, `mkdir -p apps/bbs/.data`, and import a corpus manually — `vp run dev` deliberately does not do this (the import truncates; see the `dev` task comment in `vite.config.ts`).

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
