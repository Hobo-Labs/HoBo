---
type: CI Performance Finding
title: "Finding 134: main trunk pickup delay after route"
description: "Run 43181149502 showed CI deps layer and Main workspace plan jobs queued on GitHub within one second of Route runners completing but starting on box JIT runners about two minutes later."
tags: [hobo, ci, performance, trunk, admission, worker]
---

# Finding 134: main trunk pickup delay after route

## Evidence (before)

Main Fabric run [43181149502](https://github.com/Hobo-Labs/HoBo/actions/runs/43181149502) on `db90967b8` (green, 8m08s):

| Job | `created_at` → `started_at` (after route) |
|-----|----------------------------------------|
| **CI deps layer (pnpm)** | ~1s queued → **+130s** until start |
| **Main workspace plan** | ~1s queued → **+136s** until start |
| **Main full gate** | ~1s queued → **+220s** until start |

Contrast [43176491360](https://github.com/Hobo-Labs/HoBo/actions/runs/43176491360) on `f2bd06ddf`: deps and plan **started within 1s** of route completion.

Run [43172214692](https://github.com/Hobo-Labs/HoBo/actions/runs/43172214692) on `05457ecf3` (pre-#1928) also showed **~169s** deps pickup (`created` 07:01:44 → `started` 07:04:33).

Job logs show **box JIT** runners (`hobo-<uuid>` on machine `6318404f7e01` / `c092682bdd29`), not GitHub-hosted. Workflow `needs` and `created_at` rule out slow route outputs or missing `ci-runner-image` (skipped, satisfied immediately).

## Cause

**Trunk-label runner assignment + box admission** after route: jobs are eligible as soon as route finishes, but the worker does not launch `hobo-trunk` runners until trunk slots / fleet defer / memory headroom allow. #1928 (**light plan + immediate fleet pickup for deps/plan on memory-headroom**) addresses the fast path once the **worker** on the box runs that commit.

No additional in-repo workflow change fixes a multi-minute queue without either redeploying the worker or weakening the `hobo-trunk` / admission contract.

## Fix

- **Ops:** Redeploy box worker to **`main` ≥ #1928** (`f2bd06ddf`); verify deps/plan `started_at - created_at` **&lt;15s** on the next main push (compare [43176491360](https://github.com/Hobo-Labs/HoBo/actions/runs/43176491360)).
- **Observe:** Compare `created_at` vs `started_at` on trunk jobs (this finding’s table); GitHub job wall time alone hides queue delay.

## Measure

On three consecutive main Fabric greens after worker redeploy: p50 trunk pickup **&lt;15s**, p95 **&lt;30s** (route complete → deps/plan `started_at`).

## Verification

- **TypeScript / workflow:** not applicable (worker deployment + telemetry).
- **Protobuf / CUE / PACT:** not applicable.
