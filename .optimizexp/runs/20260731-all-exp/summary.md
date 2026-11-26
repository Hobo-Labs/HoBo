# OptimizeXP all experiences — 20260731-all-exp

## Scope

| Field | Value |
|---|---|
| Experiences | **ux + dx + ax** (bare invocation) |
| Projects | all |
| Passes | **infinite** (default) |
| Auto-init | skipped (`needsInit: false`) |
| Features | all 7 on-disk feature folders |
| Mode | derive → implement until true plateau / irreducible |

## Scores

| | metric_total | metric_max |
|---|---:|---:|
| Baseline (miswires) | 6 | 3 |
| Cycle 1 pass 1 (after reduce) | **1** | **1** |
| Cycle 1 pass 2 (re-survey) | **1** | **1** |

| Persona | Feature / surface | H | F | U | exit |
|---|---|---:|---:|---:|---:|
| product-designer | design:lint | 0 | 0 | 0 | 0 |
| product-coding-agent | setup-agent-tools --help | 0 | 0 | 0 | 0 |
| product-app-developer | doctor | 0 | 0 | 0 | 0 |
| product-end-user | docs:site-nav | 0 | 0 | 0 | 0 |
| product-coding-agent | exp-proofs classification | 0 | 0 | 0 | 0 |
| product-app-developer | narrow-local discovery | 0 | 0 | 0 | 0 |
| junior-typescript-developer | agent:check --staged | 0 | 1 | 0 | — |

## Experiments this run

| Id | Change | Effect |
|---|---|---|
| E-1 | design-system-contract → `pnpm run design:lint` (+ discovery demote docs:design-lint) | DESIGN.md contract is primary agent-followable gate |
| E-2 | agent-tooling-setup steps README → setup --help | Docs match operator critical path |
| E-3 | narrow-local-validation demote gate:s1 | Discovery no longer ranks S1 stage gate high |

Also carried: skill docs for **default infinite `--passes`** (mirrors `.agents` / `.claude`) — uncommitted skill work from same session.

## Stop

**irreducible** after cycle 1 true plateau:

- Scores flat (metric_total=1, metric_max=1)
- `implementableFindingsRemaining = 0`
- Metrics not all zero (residual multi-gate agent:check friction=1 is **L**)
- Re-survey found no new S/M findings

`stopReason: irreducible` · `cyclesCompleted: 1` · `passesLabel: infinite`

## Residual (not implementable S/M here)

- Multi-gate wait when package.json + docs + skills staged together (impact-scoped policy, L)
- gbrain PATH warn on zero-key path (expected)
- Codex global config paste / first network install (host/external)

## Evidence

- `.optimizexp/features/design-system-contract/evidence/…` (`design:lint`)
- `.optimizexp/features/public-site-first-impression/evidence/…` (`docs:site-nav`)
- `.optimizexp/features/agent-tooling-setup/evidence/…` (setup --help)
- `.optimizexp/features/cli-help-and-doctor/evidence/…` (doctor)
- Bus `2026-07-31T15:01:*Z-900*`

## Next owners

- L residual: impact concurrency for multi-scope `agent:check --staged` (platform DX)
- Land uncommitted optimizexp skill + feature wiring via `/sdlc finish` when ready
