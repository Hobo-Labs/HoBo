---
type: CI Performance Finding
title: "Finding 12: main re-ran the tests its own PR had just passed"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 12: main re-ran the tests its own PR had just passed

Main push 41671509710 (merge of #1675, 407 s) spent 288 s in Main full gate:

| Step | Time | What ran |
|---|---:|---|
| Checkout, preflight, cache restore | 10 s | |
| `pnpm install` | 23 s | store host-mounted |
| S0 gate set | 101 s | 14 `agent:check` lanes at concurrency 1; `turbo run test --filter=./packages/code` alone 79 s (78 of 82 tasks cached, `@hobo/code#test` a miss), `test:root` 13 s, `typecheck:root` 5 s, the other 11 under 5 s together |
| Workspace tests | 146 s | `dependent-tests.mts`: 7 whole suites 41 s (84 of 90 cached; `@hobo/code#test` replayed from the S0 run), `@hobo/hobo` subset 92 s (75 files whose imports reach `packages/code/src/rubberhose.ts`), `examples/self-host-yard` subset 9 s, three cached subsets under 1 s |
| Prune, save, trace | 8 s | |

The run's critical path was image job 91 s (its inputs changed in #1675), then the gate. The scoping was
right: the 75 `@hobo/hobo` files reach the changed source through real imports, and the docs-only edits
in `packages/ci` and `packages/ci-gh-actions` cost nothing on their own (`*.md` is outside the `test`
inputs). The waste was `@hobo/code#test`. #1675's PR impact gate (run 41669665020) ran the same lane on the
same tree eight minutes earlier (73 s, its only miss), but its cache entry was saved under the PR's ref,
and `actions/cache` never restores a PR ref's entries on main.

Fix: on the box, `.github/actions/turbo-cache` points `TURBO_CACHE_DIR` at a directory inside the
host-mounted pnpm store (`hobo-turbo-cache`), so every job (PR, merge group, main) reads and writes one
content-addressed cache and the `actions/cache` restore and save are skipped. Turbo's task hash here is
file content only (strict env mode, no task `env` keys), so a PR gate's result replays on main when the
merged tree matches. `scripts/ci/turbo-cache-prune.mts` prunes the shared directory by the same 7-day rule
and skips files another job's prune removed. Two jobs writing one hash can leave a truncated archive for
an instant; turbo reads that as a miss and runs the task (checked by truncating a build entry). No daemon
redeploy is needed: the pnpm store mount already exists.

Expected for a push like 41671509710: S0 drops by about 77 s (the `@hobo/code#test` replay), and the image
job is about 10 s once #1676's no-rebuild skip lands, so the run goes from 407 s to roughly 250 s. The
`@hobo/hobo` subset (92 s) is the floor for a change to `@hobo/code` source; the PR gate does not run it.
