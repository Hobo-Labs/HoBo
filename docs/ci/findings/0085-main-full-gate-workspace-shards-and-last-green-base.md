---
type: CI Performance Finding
title: "Finding 85: main full gate workspace shards and last-green base"
description: "Main push shards workspace tests across fleet runners, resolves affected base from last green Fabric main, and defers gitleaks to a finish job after shards."
tags: [hobo, ci, performance, main-gate, sharding]
---

# Finding 85: main full gate workspace shards and last-green base

## Evidence

**Before serial workspace tests** — run [42928788703](https://github.com/Hobo-Labs/HoBo/actions/runs/42928788703) (`e2fbbbae`, 2026-11-11):

| Step | Wall time |
| --- | --- |
| Install dependencies | 30s |
| S0 gate set | 58s |
| Generated-output drift | 22s |
| Workspace tests | 3m21s |
| Workflow run (billable wall) | **6m09s** |

**After sharding without parallel plan** — run [42939177874](https://github.com/Hobo-Labs/HoBo/actions/runs/42939177874) (`112bbc7d`, 2026-11-11): **8m30s** wall. Shards waited on Main full gate (~2m33s); slowest shard workspace step ~4m17s.

**Target after parallel plan + balanced shards:** critical path ≈ `main-gate-plan` + `max(main-gate S0, slowest shard ≤90s budget)` + `main_gate_finish` gitleaks, aiming for **<3m** on typical affected pushes.

## Symptom

One `Main full gate` job held a trunk slot for the full serial stack above. Workspace tests dominated; gitleaks overlapped earlier steps but still blocked the job tail.

## Change

- `scripts/ci/resolve-main-test-base.mts` — last green successful Fabric push on `main`, else `event.before`, else `HEAD~1`.
- `main-gate-plan` + `scripts/ci/plan-main-workspace-shards.mts` — plan shards while S0 runs; depends on `ci-deps-image`.
- `scripts/ci/workspace-test-durations.json` — persisted per-package seconds; balanced via `dependent-tests.mts`.
- `main_workspace_tests` — matrix from the plan job; deps-layer-first bootstrap; pnpm store/install only on layer miss.
- S0 on `main-gate` uses `--external-workspace-tests` when scope is affected.
- `main_gate_finish` — gitleaks after all shards succeed.

## Expected wall clock (typical affected push)

Critical path ≈ `max(main-gate S0 + drift, slowest workspace shard) + finish gitleaks`, not the sum of shards. Doc-only pushes should drop workspace time toward the slowest shard instead of ~3m21s serial.

## Proof

- `scripts/test/main-gate-workspace-shards.test.ts`
- `scripts/test/resolve-main-test-base.test.ts`
- `scripts/test/gitleaks-main-scan.test.ts`
