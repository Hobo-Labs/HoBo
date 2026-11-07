---
type: CI Performance Finding
title: "Finding 75: blobless gitleaks never wrote an exit file"
description: "Main full gate Secret scan waited 300s after a banner-only gitleaks hang on the sparse blobless clone."
tags: [hobo, ci, performance, checkout, sparse, gitleaks]
---

# Finding 75: blobless gitleaks never wrote an exit file

## Symptom

Main Fabric [42016105215](https://github.com/Hobo-Labs/HoBo/actions/runs/42016105215) job
[127207503432](https://github.com/Hobo-Labs/HoBo/actions/runs/42016105215/job/127207503432)
at `1c5d2616` (#1744) fixed pins/install (Checkout ~6 s, pins:fetch ~1 s, Install success, S0 ~13 s,
Workspace tests ~3 s) then **Secret scan (full history)** timed out 11:08:58–11:13:58Z (300 s).
The gitleaks log was only the banner. `$RUNNER_TEMP/gitleaks/exit` was never written. The wait
loop treated a live hung process as "still running".

## Cause

#1743/#1744 kept `filter: blob:none` plus cone-mode sparse checkout and `fetch-depth: 0`.
`gitleaks git --config .gitleaks.toml` walks history with `git log -p`. On a promisor clone
every historical blob is fetched on demand. The scanner never finishes and never reaches the
shell `mv …/exit` that the wait step needs.

## Fix

`scripts/ci/gitleaks-main-scan.mts` owns start and wait:

- **push** with a reachable `github.event.before`: `gitleaks git --log-opts=before..sha`, 90 s
  command timeout, 105 s wait. Previous main already covered older history.
- **schedule** and **workflow_dispatch** (and a forced push): `git fetch --refetch --no-filter`
  then unbounded `gitleaks git`, 120 s fetch / 90 s scan / 240 s wait.
- Either path writes `$dir/exit` on timeout, crash, or a normal status.

Sparse S0 stays in place for the rest of the gate. The daily schedule is the regular
full-history path.

## Verification

`scripts/test/gitleaks-main-scan.test.ts` pins the range vs full plans, `--no-filter` backfill,
the 127207503432 hang verdicts (`died-without-exit`, `timeout` at the 300 s budget), and that
main-gate no longer shells raw unbounded `gitleaks git`. Target for a main push wait is
**about 60–90 s**, not 300 s.
