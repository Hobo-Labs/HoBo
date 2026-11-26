# OptimizeXP DX review+reduce — 20260730-dx-fix

## Scope

| Field | Value |
|---|---|
| Experiences | **dx** |
| Projects | all-projects |
| Mode | review → **reduce** → verify (not report-only) |
| Persona review+reduce passes | **2 / 3** |
| Stop reason | **plateau** (minIterations 2 met; scores flat) |
| Personas | product-app-developer, junior-typescript-developer, product-platform-engineer |
| Features | narrow-local-validation, cli-help-and-doctor, agent-check-staged |

## Scores

| | metric_total | metric_max |
|---|---:|---:|
| Baseline (pre-fix cold path) | 20 | 4 |
| After pass 1 (experiments E-1..E-3) | **9** | **2** |
| After pass 2 (E-4 align doctor messaging) | **9** | **2** |
| Δ baseline → final | **-11** | **-2** |

| Persona | Surface | H | F | U |
|---|---|---:|---:|---:|
| product-app-developer | agent:check --staged | 0 | 2 | 1 |
| product-app-developer | doctor | 0 | 2 | 1 |
| junior-typescript-developer | agent:check --staged | 0 | 2 | 1 |

## Experiments applied

| Id | Change | Impact |
|---|---|---|
| E-1 | `scripts/dx-preflight.mts` + package.json agent:check path | No tsx stack; clear next/hint |
| E-2 | doctor via strip-types preflight; node_modules check | Offline doctor works |
| E-3 | CLI capture `pipefail` + body exit recovery | Evidence exitCode 1 |
| E-4 | doctor next/hint formatting | Consistency; plateau |

## Skill updates

optimizexp default is now **apply reduce experiments each pass** (default `--iterations 3`). Opt out: `--report-only`.

## Residual debt

- Happy-path staged gates still need `pnpm install` (env).
- pnpm ELIFECYCLE trailer noise after preflight (low leverage).

## Evidence

- `.optimizexp/features/narrow-local-validation/evidence/...`
- `.optimizexp/features/cli-help-and-doctor/evidence/...`
- `.optimizexp/features/agent-check-staged/evidence/...`
- Bus `2026-07-30T19:10:00Z-1001` … `1009`

## Owners

| Item | Owner |
|---|---|
| Preflight / doctor | repo DX scripts (landed this run) |
| Capture harness | optimizexp skill (landed) |
| Full install happy-path re-score | human env or CI with node_modules |
