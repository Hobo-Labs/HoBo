# HOBO-612: hobo dev offline local loop draft POC (S1-22)

Independent draft POC for **`hobo dev`** collect → link → run with hot reload, event-sourced
`.hobo/` state, debounced codegen-in-watch, and fidelity labels. Promotes to `packages/cli/`
when S1-02, S1-16, S1-18, S1-20, and S0-04 blockers merge.

## What this proves

- Cold boot on `http://localhost:<port>` in ≤60s with **zero credentials** (FR-011 / NFR-002)
- **collect → link → run** composition using draft collect + runtime-local host proofs
- Event-sourced `dev.*` events with snapshot `.hobo/dev-state.json` (`hobo.dev-state/v1`)
- Hot reload preserves run state; `HOBO_DEV_RELOAD_ERROR` on syntax errors with daemon alive
- Debounced codegen regenerates `src/_generated/` (one run per flush window)
- Fail-closed incompatible `.hobo/` schema without corrupting stored file
- Per-capability fidelity labels: `real|simulated|mocked|camp-only`
- PACT boundaries: CLI→`@hobo/runtime-local`, CLI→codegen engine

## Reference proofs

Behavior derives from `src/draft/technical-proofs/hobo-dev-loop-contract/` (HOBO-122).
This package splits production-shaped modules (`dev-session`, `dev-state-store`, `watch-codegen`,
`hot-reload`, `fidelity`, `commands/dev`) ahead of `packages/cli/` promotion.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/hobo-612-dev-local-loop-poc test
node --import tsx scripts/ci/dev-cold-loop-timing.mts
```

## Architecture evidence

- `data-models/dev_loop.proto` + `dev_loop.cue` — records, `dev.*` events, CUE constraints
- `contracts/cli-dev-runtime-local.pact.json`, `contracts/cli-dev-codegen.pact.json`
- `ADR.md` — parse-don't-validate + CQRS event architecture

## Promotion path

Target: `packages/cli/src/dev/*`, `packages/cli/data-models/dev_loop.*`, stage-gate
`scripts/ci/dev-cold-loop-timing.mts` (network-disabled CI job).
