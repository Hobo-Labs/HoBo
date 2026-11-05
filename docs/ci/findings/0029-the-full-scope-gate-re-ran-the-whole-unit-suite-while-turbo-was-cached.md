---
type: CI Performance Finding
title: "Finding 29: the full-scope gate re-ran the whole unit suite while turbo was cached"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 29: the full-scope gate re-ran the whole unit suite while turbo was cached

Main push run **41800198423** took **6m27s** (previously 97 s). Its S0 gate took **3m30s**, with about **180 s** in root `test:unit`: `pretest:unit` replayed the cached build graph, then `scripts/run-tests.ts --category=unit` executed the root and draft Vitest files again at `HOBO_RELEVANT_CHECK_CONCURRENCY=1`. Package build/test cache hits therefore did not make the full-scope S0 gate cheap.

The unit graph is strict parity with the current legacy selector: **758 files = 25 root Vitest + 1 root `node:test` + 732 draft**, excluding draft `node:test`-style files and the frozen live-repo test. Root Node files execute after Vitest in their assigned cached shard. Four root shards use stable path hashes. Nine draft shards use a stable hash of the proof package directory (`src/draft/<kind>/<slug>` or `src/draft/exp-proofs/<type>/<slug>`), keeping each proof in one shard and making each shard's turbo inputs a generated list of its proof directories. Nine is the smallest plain-hash shard count that separates the five heavy proof directories measured locally; no timing data is read at runtime. `pnpm run test:unit:shards` regenerates the turbo inputs and package scripts, and `pnpm run test:unit:shards:check` rejects drift. Production `packages/**` suites remain in Workspace tests, and `scripts/test/` remains in `test:scripts`. A shared turbo dependency runs the same 136 builds as the old pretest; exclusion-only inputs avoid hashing the root tree merely to track those dependencies.

`scripts/lib/unit-test-coverage.ts` proves exact set equality in both directions, rejects duplicate shard assignments, verifies every selected file is in its shard's turbo inputs, and tests that no proof directory spans shards. The complete graph has 150 tasks: 136 builds, one dependency task, and thirteen test shards. Worker caps follow main's `min(configured, memory)` logic; turbo parallelism follows `HOBO_TURBO_CONCURRENCY`, and root workers honor `HOBO_TEST_MAX_WORKERS` then `HOBO_RELEVANT_CHECK_CONCURRENCY`.

Serial validation used `HOBO_TURBO_CONCURRENCY=1` and `HOBO_TEST_MAX_WORKERS=1`, with no source changes between runs:

| Lane | First run | Second (warm) run | Second-run cache |
|---|---:|---:|---:|
| `test:unit` | 165.9 s (137 / 145 cached) | **2.5 s** | **145 / 145 cached (FULL TURBO)** |
| `check:all` | 36.6 s (warm) | not rerun | unit graph fully cached |

The first merged unit run missed only the eight test shards whose runner/selection inputs changed; all 136 builds and the dependency task were cached. The second was fully cached. The warm full-scope gate is therefore under 60 seconds. Its measured steps were:

| Warm `check:all` step | Seconds |
|---|---:|
| `lint:boundaries` | 0.6 |
| `lint:test-deps` | 9.4 |
| `architecture:guard:all` | 1.3 |
| `konsistent` | 0.8 |
| `lint:docs` | 1.1 |
| `design:lint` | 1.4 |
| `draft:artifacts` | 0.6 |
| `draft:cascade` | 0.7 |
| `skills:mirror-check` | 0.6 |
| `promotions:check` | 0.6 |
| `case:check` | 0.6 |
| `test:schema` | 16.4 |
| `test:unit` | 6.0 |
| `test:behavior` | 2.9 |
| `standards:check` | 0.7 |
| `licenses:check` | 0.8 |
| `docs:coverage` | 0.5 |
| `docs:freshness` | 0.5 |

The remaining multi-second non-cached steps are `test:schema` and `lint:test-deps`; they stay unchanged in this PR.

The package-hash follow-up forced both full graphs with `turbo run ... --force` at the default concurrency. Total cold wall time fell from **177.314 s** (145 tasks) to **160.778 s** (150 tasks). Vitest reported these per-shard cold durations; the four root assignments were unchanged:

| Shard | Before files | Before cold | After files | After cold |
|---|---:|---:|---:|---:|
| root 0 | 5 | 3.27 s | 5 | 1.77 s |
| root 1 | 10 | 2.13 s | 10 | 1.26 s |
| root 2 | 5 | 9.43 s | 5 | 8.27 s |
| root 3 | 5 + 1 Node | 4.34 s | 5 + 1 Node | 4.43 s |
| draft 0 | 519 | 84.38 s | 83 | 10.35 s |
| draft 1 | 161 | 21.57 s | 83 | 10.55 s |
| draft 2 | 29 | 18.67 s | 73 | 14.87 s |
| draft 3 | 23 | 3.40 s | 93 | 11.38 s |
| draft 4 | — | — | 86 | 7.99 s |
| draft 5 | — | — | 68 | 6.67 s |
| draft 6 | — | — | 77 | 79.99 s |
| draft 7 | — | — | 79 | 25.27 s |
| draft 8 | — | — | 90 | 11.64 s |

The serial file total stayed at 732 draft files and 758 files overall. The after run passed 150/150 tasks; the immediately following `pnpm run test:unit` was **150/150 cached (FULL TURBO)** in **574 ms** of turbo time. Adding one blank line to `registry-publish-flow-contract/test/registry-publish-flow.test.ts` then invalidated exactly one draft shard, draft 5, which ran its 68 files in **3.72 s**. Existing broad root inputs also reran root shards 0, 1, and 3; root shard 2 and the other eight draft shards stayed cached. Removing the line restored the original file.

The cold critical path is still the isolated `componentize-js-determinism-spike/test/nondeterminism-spike.test.ts` at **79.0 s**, so this change does not claim a sub-60-second cold unit run. The measured warm full-scope unit graph remains well under 60 seconds.
