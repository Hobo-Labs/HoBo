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

CI job containers run with umask `0002`. The fixture's bare `mkdirSync(dir)` therefore created its OpenSesame stand-in `bin` directory as `0775` (group-writable). The adapter's trust check correctly refused to start a binary from that directory; the fixture had depended on the developer's narrower local umask.

## Fix

Create the fixture directories with `mkdirSync(dir, { mode: 0o755 })`. The umask can only clear permission bits, so the resulting directory is never group- or other-writable. Product code remains unchanged.

The box worker's runner ran with umask `0000`, so job steps created group- or other-writable directories. The runner start script now sets `umask 022`, and the fixture both creates directories with mode `0o755` and chmods them to that mode, so it does not depend on the runner's umask.

A second false signal came from `turbo-ci.test.ts`: its deliberately failing fixture made a child Turbo print an `app#test` exit 7 through GitHub's `##[error]` workflow command, annotating the real job despite the passing suite. The test now stubs only `GITHUB_ACTIONS` around each case and restores it afterward, preventing those annotations while production Turbo continues to inherit the real CI environment.

The pre-commit hook exposed a more serious isolation gap: exported `GIT_DIR` and `GIT_INDEX_FILE` made fixture Git commands and Turbo's affected detection operate on the real repository, rewriting its index and creating a fixture `base` commit. `isolateTurboEnv()` now removes the canonical `LOCAL_REPO_ENV` variables alongside `TURBO_*` for each test file and restores them afterward.

## Verification

Run `test/bin-opensesame.test.ts` under umask `0002` and under the ambient umask. Both runs must pass, along with the findings-index check and scoped Biome and anti-slop lint.
