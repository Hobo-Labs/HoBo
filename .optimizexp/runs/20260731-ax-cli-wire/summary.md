# OptimizeXP AX — 20260731-ax-cli-wire

## Scope

| Field | Value |
|---|---|
| Experiences | **ax** |
| Prior | ax-doctor (doctor agent-tooling section, uncommitted in same tree) |
| Features | cli-help-and-doctor, agent-tooling-setup |
| Personas | product-coding-agent, product-agent-operator |

## Scores

| | metric_total | metric_max |
|---|---:|---:|
| Baseline (live eval as doctor path) | 6 | 4 |
| Pass 1 | **0** | **0** |
| Pass 2 | **0** | **0** |

## Experiments

| Id | Change |
|---|---|
| E-1 | Rewire `cli-help-and-doctor` primaryCommand → `pnpm run doctor` (not `eval:agent:live`) |
| E-2 | Doctor `warn` lines on stdout for agent transcripts |
| E-3 | `test/doctor-agent-tooling.test.ts` regression guard |

## Stop

**plateau** — scores flat, implementableFindingsRemaining = 0.

## Residual

- Codex global config paste (host)
- Network first install (external)

## Evidence

- `.optimizexp/features/cli-help-and-doctor/evidence/…`
- Bus `2026-07-31T14:05:00Z-7001-*`
