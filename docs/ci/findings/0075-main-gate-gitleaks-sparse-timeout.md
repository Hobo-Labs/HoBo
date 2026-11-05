---
type: CI Performance Finding
title: "Finding 75: main gate gitleaks sparse timeout"
description: "gitleaks git without --log-opts stalled on promisor blobs; Main full gate secret scan hit the 300s wait."
tags: [hobo, ci, performance, gitleaks, sparse, security]
---

# Finding 75: main gate gitleaks sparse timeout

## Symptom

After #1744 (sparse S0 checkout with `fetch-depth: 0`), Main full gate failed only on **Secret scan
(full history)**: the background `gitleaks git` process never wrote `$RUNNER_TEMP/gitleaks/exit`
within 300s (runs 42016105215 on `1c5d2616`, same on `6464a491` after #1743). Productive gate
steps finished in ~45s; wall time was dominated by the scan wait.

## Cause

Unscoped `gitleaks git` walks all commits and diffs blobs. On a sparse, blobless cone, history
walks trigger slow or stuck promisor fetches — same class of problem as Finding 73, but on the
scan rather than checkout.

## Fix

`scripts/ci/gitleaks-main-gate.mts` scopes scans like the PR **Secret scan** job (`before..HEAD`
on push, `--since=7.days` on schedule, working-tree `gitleaks detect` when the range is
unknown). The worker always writes an exit marker (including gitleaks timeout exit 124) so the
wait step cannot hang indefinitely. Main gate step names are **gate range**, not full history.

## Verification and expectation

- `scripts/test/gitleaks-main-gate.test.ts` pins range resolution.
- `scripts/test/s0-checkout-cone.test.ts` and `packages/ci-gh-actions/test/main-gate-image-wait.test.ts`
  assert start/wait step names and adjacency.
- Target: secret scan completes in seconds on a typical main push; Main full gate wall stays under
  the ~3 minute budget when other steps stay affected-scoped.

## Residual risk

Force pushes with an unreachable `before` SHA fall back to working-tree detect only (no history).
Full-repo history attestation for Target A remains the pre-public runbook, not this gate.
