---
type: CI Performance Finding
title: "Finding 73: Main S0 checkout fetched unused trees"
description: "Main full gate S0 paid for a full recursive checkout before an affected-only gate."
tags: [hobo, ci, performance, checkout, sparse]
---

# Finding 73: Main S0 checkout fetched unused trees

## Symptom

The best recent Main full gate S0 step was about **19 s**, and was about **25 s after #1734**, before the gate's
commands started dominating the step. Its checkout fetched the complete worktree and recursively cloned
ts-autocode even though the deps layer already supplies the sibling links. S0 does not read `media/`.

## Fix

Main full gate now uses the release jobs' bootstrap plus `hobo-checkout` sequence. Its canonical S0 cone in
`scripts/ci/checkout-cone.mts` retains the inputs required by `agent:check`, `check:all`, and full-history
gitleaks, excludes `media/`, disables submodule recursion and tags, and keeps `filter: blob:none` with
`fetch-depth: 0`.

Before checkout, the composite probes `HOBO_CI_GIT_MIRROR` and the planned box mirror paths. A bare mirror is used
only when it contains the triggering commit. A hit writes `file://` `insteadOf` mappings through
`GIT_CONFIG_SYSTEM`; a miss falls back to GitHub without failing the job. Worker-side mirror population and mounts
remain Phase 2.

## Verification and expectation

`scripts/test/s0-checkout-cone.test.ts`, `scripts/test/box-git-mirror.test.ts`, and the existing release-cone
contract cover the workflow, cone, mirror fallback, missing-SHA refusal, and executable probe. The
`main-gate-image-wait` contract asserts the gitleaks start/wait steps by name and adjacency
(after `ci-runner-preflight` so Node can run `gitleaks-main-scan.mts`; wait after Workspace tests),
not by a numeric step index — bootstrap plus `hobo-checkout` shifted the old unnamed-checkout
`mainNames[1]` slot. Finding 75 covers the blobless full-history hang.

The target for an affected main push is **S0 about 10–12 s** once checkout is sparse and blobless. A mirror hit
also makes the checkout pack local. This is an estimate, not a measured post-change run: the S0 commands can still
be command-bound, so the next main run must record the actual checkout and gate durations separately.

#1743 left the ts-autocode gitlink empty, so the first main run missed the deps key and died in `pnpm prepare`.
Finding 74 adds `pins:fetch ts-autocode` after preflight; it does not restore recursive submodules.
