# @hobo/yard-world — agent notes

- **What it is:** the pure yard-world model (OTel signals → HoBo primitives as
  an animated tile world). Promoted from `src/draft/projects/otel-office/`.
- **Zero runtime deps.** Do not add dependencies — not even other `@hobo/*`
  packages. Dev deps (`vitest`, `@types/node`) only.
- **No I/O in the core.** Everything exported from `src/index.ts` must stay
  pure (no `node:*` imports, no network, no wall clock beyond injectable
  `now`). The single node-only exception is `src/layout-store.ts`, exposed via
  the `@hobo/yard-world/layout-store` subpath and never re-exported from the
  index.
- **No server here.** HTTP/SSE serving belongs to the hosting service
  (control-api). The draft's `server.ts`/client were intentionally left behind.
- **Contracts:** boundary records in `data-models/yard_world.proto` +
  `data-models/yard_world.cue` (keep them in lockstep — every proto message
  needs a CUE definition); PACT fixture in
  `contracts/yard-world-boundary.pact.json` pins the intended serving boundary.
- **Determinism:** the simulator must stay seed-deterministic (mulberry32,
  tick clock, no `Date.now()` in the sim loop); `test/simulator.test.ts`
  enforces it.
- Run `pnpm --filter @hobo/yard-world test` and repo-root
  `npm run architecture:guard` after changes.
