# OptimizeXP AX — 20260731-ax-review

## Scope

| Field | Value |
|---|---|
| Experiences | **ax** |
| Projects | all |
| Stop policy | true-plateau-only (no iterations flag) |
| Personas | product-coding-agent, product-agent-operator |
| Features | agent-tooling-setup |
| Mode | reduce until plateau |

## Scores

| | metric_total | metric_max |
|---|---:|---:|
| Baseline (pre-reduce) | 9 | 3 |
| Pass 1 (help + gbrain launcher + AUTH/docs + feature rewire) | **0** | **0** |
| Pass 2 (re-verify) | **0** | **0** |

| Persona | Surface | H | F | U | notes |
|---|---|---:|---:|---:|---|
| product-agent-operator | setup --help + gbrain fail-closed + mirrors | 0 | 0 | 0 | AUTH named |
| product-coding-agent | setup --help | 0 | 0 | 0 | zero-key flags clear |

## Experiments this run

| Id | Change | Effect |
|---|---|---|
| E-1 | `setup-agent-tools.sh --help` + usage on unknown options | Operator cold path no longer dead-ends on `unknown option` |
| E-2 | `scripts/agent-mcp-gbrain.sh` + MCP config wiring | Missing binary/key fails closed with AUTH remediation |
| E-3 | Done footer + AUTH/docs/AGENTS/.env.example pointers | Single key/egress surface discoverable |
| E-4 | agent-tooling-setup primaryCommand → setup --help | Feature measures real progressive-setup journey |

## Stop

**plateau** — scores flat, implementableFindingsRemaining = 0 for measured cells.

```text
should-stop → stop: true, reason: plateau, backlogEmpty: true
```

## Residual (not implementable S/M for these surfaces)

- Full setup install still chatty when tools already present (quiet/idempotent mode = L)
- Codex global config paste remains a host constraint (documented in `.codex/config.toml`)
- Hosts may still prompt to enable gbrain MCP — intentional; decline for zero-key, launcher fails closed if accepted without binary/key

## Evidence

- `.optimizexp/features/agent-tooling-setup/evidence/agent-tooling-progressive-setup-works-for-product-agent-operator/`
- `.optimizexp/features/agent-tooling-setup/evidence/agent-tooling-progressive-setup-works-for-product-coding-agent/`
- Bus `2026-07-31T13:32:*Z-400*`
