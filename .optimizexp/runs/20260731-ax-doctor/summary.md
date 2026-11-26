# OptimizeXP AX — 20260731-ax-doctor

## Scope

| Field | Value |
|---|---|
| Experiences | **ax** |
| Prior | 20260731-ax-continue |
| Personas | product-agent-operator, product-coding-agent |
| Surfaces | `pnpm run doctor`, setup `--help` |

## Scores

| | metric_total | metric_max |
|---|---:|---:|
| Baseline | 4 | 3 |
| Pass 1 (doctor agent-tooling) | **0** | **0** |
| Pass 2 re-verify | **0** | **0** |

## Experiments

| Id | Change |
|---|---|
| E-1 | `scripts/doctor.ts` AUTH/MCP/setup/launchers + PATH warns; docs/help pointers |

## Stop

**plateau** — scores flat, implementableFindingsRemaining = 0.

## Residual

- Codex global config paste (host)
- Network first install (external)
- gbrain absent → warn only (zero-key OK)
