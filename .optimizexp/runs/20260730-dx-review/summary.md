# OptimizeXP DX review — 20260730-dx-review

## Scope

| Field | Value |
|---|---|
| Experiences | **dx** only |
| Projects | all-projects (default) |
| Persona review passes | 1 / 1 |
| Focus personas | product-app-developer, product-platform-engineer, developer, junior-typescript-developer |
| Features exercised | narrow-local-validation, cli-help-and-doctor, agent-check-staged |
| Auto-init | skipped (`needsInit: false`) |
| Mode | report-only |
| Bus corrections | **3** (`correctedFrom` prior mismatches) |

## Scores

| | metric_total | metric_max |
|---|---:|---:|
| Baseline (prior judged) | 20 | 4 |
| After pass 1 (judged) | **20** | **4** |
| Δ | 0 | 0 |

| Persona | Surface | harms | friction | uncertainty | matched? |
|---|---|---:|---:|---:|---|
| product-app-developer | agent:check --staged | 0 | 4 | 3 | yes |
| product-app-developer | doctor | 0 | 4 | 2 | yes |
| junior-typescript-developer | agent:check --staged | 0 | 4 | 3 | yes |

## Bus feedback

Prior run `20260731-dx-review` had optimistic expects (predicted exit 0 / low friction). This pass applied lessons:

- `correctedFrom` → `2026-07-31T03:58:00-outcome`, `…03:58:10-outcome`, `…03:28:20Z-0003`
- Predicted high friction; **all three outcomes matched**
- Plateau: scores unchanged without install or preflight reduction

## Findings (ranked)

1. **F-1** Shared DX entrypoints need install/tsx before useful output (friction 4)
2. **F-2** Evidence capture exit masking via pipe/head (uncertainty)
3. **F-3** Doctor not zero-setup offline preflight
4. **F-4** Single `node --import tsx` bootstrap cliff (platform)

## Stop reason

`cap` — single persona scenario-review pass complete. No plateau-stop needed (maxIterations=1).

## Next reductions (report-only)

- Preflight install-first banner + non-zero exit before stack
- Offline / strip-types doctor path
- Capture harness `pipefail` or body-derived `effectiveExitCode`
- Then `/optimizexp --dx --iterations 2` to re-score

## Owners

| Finding | Suggested owner |
|---|---|
| F-1 / F-3 / F-4 | product DX (`scripts/doctor.ts`, `package.json` scripts) or `/sdlc` issue |
| F-2 | optimizexp harness (`capture-evidence` / cli driver) |
| Broader audit | `/improve` DX lane |

## Evidence

- `.optimizexp/features/narrow-local-validation/evidence/narrow-local-validation-after-a-small-change-works-for-product-app-developer/`
- `.optimizexp/features/cli-help-and-doctor/evidence/cli-help-and-doctor-path-works-for-product-app-developer/`
- `.optimizexp/features/agent-check-staged/evidence/staged-agent-check-is-narrow-and-actionable-after-a-skill-edit-works-for-junior-typescript-developer/`
- Bus: `2026-07-30T18:00:00Z-0001` … `2026-07-30T18:01:25Z-0009`
