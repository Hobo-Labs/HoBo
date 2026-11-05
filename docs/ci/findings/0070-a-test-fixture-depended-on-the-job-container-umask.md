---
type: CI Performance Finding
title: "Finding 70: a test fixture depended on the job container umask"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 70: a test fixture depended on the job container umask

## Symptom

The merge-group PR impact gate failed three tests in `packages/hobo/test/bin-opensesame.test.ts` with `opensesame_bin_untrusted` for any PR whose affected tests reached `@hobo/hobo`. Main push runs passed because their scope did not reach that package.

## Cause

The box worker's runner inherited umask `0000`, so job-step `mkdirSync` created group- and other-writable directories (`0777`). GitHub-hosted and some container images use umask `0002`, which still leaves the fixture `bin` directory group-writable (`0775`). OpenSesame's trust check correctly refuses to start a binary from either place; the fixture had depended on a developer's narrower local umask.

## Fix

`startRunner` sets `umask 022` after `set -eu` so every job step inherits a conservative mask. The OpenSesame fixture also `chmodSync(dir, 0o755)` after each `mkdirSync`, so the stand-in `bin` directory is trusted regardless of the runner's umask.

## Verification

Run `packages/ci-gh-actions/test/isolated-worker-parallel.test.ts` (asserts the start script contains `umask 022`) and `packages/hobo/test/bin-opensesame.test.ts` under umask `0000` and `0002`. Both must pass. Redeploy the box daemon so new job containers pick up the start-script change.
