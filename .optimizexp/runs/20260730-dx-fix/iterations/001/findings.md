# Findings — iteration 001

## Experiments applied this pass

### E-1 / F-1: DX preflight for agent:check
- Files: `scripts/dx-preflight.mts`, `package.json` (`agent:check`, `check:relevant*`, `check:changed*`)
- Hypothesis: clear install-first messaging lowers friction/uncertainty vs tsx stack
- Result: **improved** — friction 4→2, uncertainty 3→1

### E-2 / F-3: Offline doctor (no tsx dependency)
- Files: `package.json` doctor script → dx-preflight; `scripts/doctor.ts` node_modules check
- Hypothesis: doctor should run and diagnose cold clones
- Result: **improved** — doctor runs offline; friction 4→2, uncertainty 2→1

### E-3 / F-2: Capture pipefail + body exit recovery
- Files: `.agents/skills/optimizexp/harness/drivers/cli.mts` (+ mirror)
- Hypothesis: exitCode 0 under `| head` inflated uncertainty
- Result: **improved** — evidence shows `exitCode: 1` / `spawnStatus: 1`

## Residual findings

### R-1: Happy path still requires install
- Metrics: friction=2 residual (expected offline)
- Smallest next: none without `pnpm install` in env; docs already say setup
- Effort: env

### R-2: pnpm ELIFECYCLE/WARN still trails preflight
- Uncertainty contribution low (≤1)
- Optional: quieter pnpm wrapper — low leverage
