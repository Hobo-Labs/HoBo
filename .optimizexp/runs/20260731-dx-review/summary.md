# OptimizeXP DX review — 20260731-dx-review

## Scope

| Field | Value |
|---|---|
| Experiences | **dx** only |
| Projects | all-projects (default) |
| Persona review passes | 1 / 1 |
| Focus personas | product-app-developer, product-platform-engineer, developer |
| Features exercised | narrow-local-validation, cli-help-and-doctor |
| Auto-init | skipped (already bootstrapped) |

## Scores

| | metric_total | metric_max |
|---|---:|---:|
| Baseline (predicted) | 4 | 2 |
| After pass 1 (judged) | **18** | **4** |

| Persona | Surface | harms | friction | uncertainty |
|---|---|---:|---:|---:|
| product-app-developer | agent:check --staged | 0 | 4 | 3 |
| product-app-developer | doctor | 0 | 4 | 2 |
| product-platform-engineer | bootstrap shared failure mode | 0 | 3 | 2 |

## Findings

1. **F-1:** All primary DX entrypoints (`agent:check`, `doctor`) fail identically without `node_modules`/`tsx` — high friction for app developers; install hint exists but stack-trace-first.
2. **F-2:** Evidence capture exit codes can be 0 under shell pipelines while body shows failure — uncertainty for persona judgment.

## Stop reason

`cap` — single persona scenario-review pass complete.

## Next reductions (report-only)

- Document install-first in DX ladder / doctor offline path.
- Prefer non-tsx help banner or static doctor when deps missing.
- Fix capture harness `pipefail` / avoid masking exits.

## Evidence

- `.optimizexp/features/narrow-local-validation/evidence/...`
- `.optimizexp/features/cli-help-and-doctor/evidence/...`
