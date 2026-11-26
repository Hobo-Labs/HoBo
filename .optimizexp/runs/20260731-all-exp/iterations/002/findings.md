# Findings — 20260731-all-exp / iteration 002 (re-survey after plateau)

## Re-survey method

- Re-probed all 7 feature primaryCommands (all exit 0)
- Compared discovery[0] vs primaryCommand for every feature (aligned)
- Grepped high-confidence bindings for gate:s1 / eval:agent:live / wrong design lint (none)
- Reviewed residual from prior DX plateau (multi-gate wait)

## New implementable S/M findings

**None.**

## Open residual (not S/M)

### R-1: multi-gate agent:check wait
- Metrics: friction=1 on agent-check-staged cell
- Effort: **L** (impact-scoped concurrency policy)
- Not implementable as S/M in this invocation

### R-2: host/external
- gbrain not on PATH (expected zero-key warn)
- Codex global config paste (host)
- First install network (external)

## implementableFindingsRemaining

**0**
