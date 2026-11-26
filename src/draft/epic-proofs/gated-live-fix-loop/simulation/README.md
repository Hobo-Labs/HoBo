# Gated Live-Fix Loop Simulation

Deterministic simulation for HOBO-654 acceptance evidence.

## Command

```bash
pnpm --prefix src/draft/epic-proofs/gated-live-fix-loop run simulate
```

## Fixture

`fixtures/gated-live-fix-loop-fixture.json` models a staging SLO regression that
drives a low-risk live-fix candidate through canary observation, auto-rollback on
canary SLO burn, and permanent failing-trace retention.

Expected output status: `rolled-back`.
