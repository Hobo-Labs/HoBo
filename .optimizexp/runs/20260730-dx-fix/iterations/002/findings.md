# Findings — iteration 002

## Experiment E-4
- Align doctor missing-modules message with `next` / `hint` lines (same shape as agent:check preflight)
- Files: `scripts/doctor.ts`
- Result: **no further metric drop** (already friction 2 / uncertainty 1) — plateau for cold-clone path

## Residual (blocked without install)
- R-1: staged gate selection still unreachable until `pnpm install`
- Not reduced further in this environment (no install experiment requested beyond messaging)
