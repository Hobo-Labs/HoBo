# Reduction — iteration 001

| Field | Value |
|---|---|
| Findings | F-1, F-2, F-3 (prior DX debt) |
| Experiments | E-1 dx-preflight, E-2 offline doctor, E-3 capture pipefail |
| Result | **improved** metric_total 20→9, metric_max 4→2 |
| Files | `scripts/dx-preflight.mts`, `scripts/doctor.ts`, `package.json`, optimizexp `cli.mts` + skill docs |

## Hypothesis → evidence

Cold-clone DX entrypoints should fail with install next steps, not Node stacks; capture harness must report non-zero. Verified via overwrite captures on narrow-local-validation, cli-help-and-doctor, agent-check-staged.
