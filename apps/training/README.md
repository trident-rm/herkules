# Training

Local course framework using VitePress + Vue,
Markdown lessons, a browser-worker PID lab, and an editable Rust Playground demo.
This is a new workspace; it does not move or modify the sibling `herkules-training`.

## Commands

From the monorepo root:

```sh
vp install
vp run @herkules/training#dev       # http://127.0.0.1:3004
vp run @herkules/training#build     # Vue/TS checks + static output in apps/training/dist
vp run @herkules/training#test
vp run ready
```

`vp run dev` also starts training. No env file, backend or database is required.

## Authoring

- Add lessons under `docs/` and navigation in `docs/.vitepress/config.mts`.
- Lesson language is Simplified Chinese with English technical terms.
- Embed `<ClientOnly><PidLab /></ClientOnly>` or `<ClientOnly><RustLab /></ClientOnly>`.
- Register reusable Vue widgets in `docs/.vitepress/theme/index.ts`.
- Everything under `docs/` is public. Keep contributor documentation outside it.
- The site uses root-based clean URLs; never carry over the sibling site's Pages prefix.
- VitePress is pinned to the same alpha as the sibling course project. Validate upgrades
  with Vue type checking, a production build, worker interaction and clean-URL checks.

Vue type checking uses workspace-local TypeScript 5.9 because `vue-tsc` currently
requires the JavaScript compiler API removed by the root TypeScript 7 package.
The root Vite+ lint/type checks remain enabled.

## Current demos

The PID lab uses a deterministic TypeScript reference simulation in a Web Worker:
5 ms fixed integration, continuous live execution with a bounded 12 s rolling history, independent yaw/pitch dynamics, actuator torque limits,
conditional-integration anti-windup and continuous pitch gravity (mgl cos θ). Plotting uses uPlot. Values
are explicitly bounded. The Rust firmware PID crate is not yet imported or
compiled to WASM; this teaching model is not firmware-equivalent.

The Rust editor uses CodeMirror. Clicking its clearly labelled external link sends
source to the official Rust Playground. There is no fake local compile result,
server-side code execution, persistent progress, authentication or grading.
The source is held in memory and resets on page reload.

## Extension boundary

Keep lesson rendering static. A future same-origin `/api/exercises` service should
reuse Herkules OAuth and own submissions, quotas and progress. Suggested contract:

- `POST /api/exercises/:id/submissions` with `{ source, exerciseVersion }` returns
  `202 { id }`; the server selects the toolchain, harness and dependency allowlist.
- `GET /api/submissions/:id` returns queued/compiling/running/completed/failed,
  structured diagnostics, bounded output and test results; authorize ownership.
- Optional WASM artifacts expose a versioned controller ABI for a browser worker.
  Grade separately on the server; client results are not authoritative.

Compilation must run outside the web service in isolated, resource-limited jobs,
including Cargo build scripts and macros. No network, host secrets or arbitrary
user dependency manifests. WASI execution needs explicit resource budgets too.
Do not point this public UI at an unrestricted shell or a Docker socket.

A future Rust/WASM implementation can replace the simulation worker behind its
`parameters` / `running` / `reset` commands and `{ history, current, running }` snapshots. First add parity
checks against the fixed-step reference and pin the firmware crate revision.

The PID lab includes a dependency-free SVG isometric gimbal: just two solid rods, a vertical blue yaw post and a green pitch arm extending forward from its top. Actual yaw/pitch angles from separate PID states drive the solid model and degree-valued graph. The payload mass is 1 kg, its center-of-mass offset is 0.3 m, both modeled inertias are 1 kg·m², and damping is 1.2 N·m·s/rad. Gravity acts on pitch from t=0; there is no timed load step or spring. The axes share tuning gains but do not simulate inertia coupling or mechanical stops. A gravity arrow and target marker explain the motion. The simulation starts live. Parameter changes preserve position, velocity, integral state, time, and history. Pause freezes state; reset explicitly clears state/history while retaining tuning. Background timer throttling slows simulation time; catch-up per tick is capped at 100 ms. Current errors and pitch torque replace finite-run summary metrics. History is capped at 601 samples.

## Local agent tuning

Run the local lab on port 3004 and configure a stdio MCP client to launch Node 24 with the absolute path to `src/agent/main.ts`. Do not launch through `vp run` inside an MCP config: stdout is reserved for the protocol. `connect_lab` returns a fresh process-scoped pairing URL for the browser's opt-in Agent panel. The WebSocket binds only `127.0.0.1:3014` (`TRAINING_BRIDGE_PORT` overrides the port); it checks the token and exact lab Origin, allows one tab, limits frames and pending commands, and rejects stale snapshots. Run the lab and bridge on the same computer.

Tools: `connect_lab`, `read_lab`, `set_parameters` (partial patch), `set_running`, `reset_lab`. Writes resolve only after a worker acknowledgement; disconnect/timeouts mean unknown outcome, so read before retrying. Manual and agent controls share state; last-applied values win. Disconnect in the page immediately ends access. Pairing tokens are not persisted; do not commit them. The short reusable skill is `skills/herkules-pid-tuning/SKILL.md`; setup instructions are in `docs/guide/agent-tuning.md`.

UI and worker validation share `bounds`: Kp 0–400, Ki 0–200, Kd 0–100, torque 1–300 N·m, yaw ±360°, pitch ±180°. The geometric model has no mechanical stops; extreme values are educational stress tests, not hardware-safe calibration limits.
