# OptimizeXP AX — 20260731-ax-continue

## Scope

| Field | Value |
|---|---|
| Experiences | **ax** |
| Prior run | 20260731-ax-review (merged #968) |
| Personas | product-coding-agent, product-agent-operator |
| Features | agent-tooling-setup |
| Stop policy | true-plateau-only |

## Scores

| | metric_total | metric_max |
|---|---:|---:|
| Baseline (re-run noise + bare MCP) | 5 | 3 |
| Pass 1 (skip reinstall + MCP launchers + failure path) | **0** | **0** |
| Pass 2 (re-verify) | **0** | **0** |

## Experiments

| Id | Change | Effect |
|---|---|---|
| E-1 | Skip serena/headroom reinstall when present | Re-run ~1.5s, no pip dump |
| E-2 | Fail-closed `agent-mcp-serena.sh` + `agent-mcp-headroom.sh`; wire MCP configs | Missing binary → setup remediation |
| E-3 | Feature `observeFailure` → gbrain fail-closed | Failure scenario evidence real |

## Stop

**plateau** — scores flat, implementableFindingsRemaining = 0.

## Residual

- Codex global config paste (host constraint)
- First-time install still network-bound
- Host may prompt for optional gbrain MCP (decline for zero-key)

## Evidence

- `.optimizexp/features/agent-tooling-setup/evidence/…`
- Bus `2026-07-31T13:43:*Z-500*`
