---
type: CI Performance Finding
title: "Finding 137: main gate plan preflight mise"
description: "Main workspace plan spent 4m53s in ci-runner-preflight on mise install --locked while the plan script itself took ~7s."
tags: [hobo, ci, performance, main-gate, preflight, mise]
---

# Finding 137: main gate plan preflight mise

## Evidence

Main Fabric run [43183884926](https://github.com/Hobo-Labs/HoBo/actions/runs/43183884926): **Main workspace plan** **6m43s** (08:34:03–08:40:46 UTC) vs the usual **16–20s**. Step breakdown: checkout ~6s; **`ci-runner-preflight` ~4m53s**; plan script ~7s.

## Cause

`main-gate-plan` is install-free for pnpm/turbo, but still runs full **`ci-runner-preflight`**, which executes **`mise install --locked`** on every start. On a warm box under CI load that dominated wall time; it was not the planner.

## Fix

Add composite input **`install-toolchain`** (default **true**). **`main-gate-plan`** passes **`install-toolchain: false`** so the fleet image's baked toolchain is used. Preflight then runs **verify-only** mise (`MISE_EXPERIMENTAL=1` on the verify step): `mise install --locked --dry-run-code`, **`mise current <tool>` vs each `[[tools.*]]` version in `mise.lock`**, missing-tool check, plus `evaluateCiRunnerContract` — no install, fail closed on drift from **`mise.lock`**; verify failures cite the failing mise command (including **`--dry-run-code`**) without duplicating **`spawnCommand`** diagnostics.

## Verified

- **TypeScript (Vitest):** `pnpm run test:smoke scripts/test/ci-runner-image-contract.test.ts` (`assertPinnedMiseToolchain`, verify-only drift)
- **Protobuf / CUE:** not applicable (shell/mise boundary only)
- **PACT:** not applicable (composite preflight, no HTTP integration)

## Measure

**Main workspace plan** preflight under **~30s** on a warm `hobo-trunk` runner; plan step unchanged.
