---
type: CI Performance Finding
title: "Finding 29: the full-scope gate re-ran the whole unit suite while turbo was cached"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 29: the full-scope gate re-ran the whole unit suite while turbo was cached

Main push run **41800198423** took **6m27s** (previously 97 s). Its S0 gate took **3m30s**, with about **180 s** in root `test:unit`: `pretest:unit` replayed the cached build graph, then `scripts/run-tests.ts --category=unit` executed the root and draft Vitest files again at `HOBO_RELEVANT_CHECK_CONCURRENCY=1`. Package build/test cache hits therefore did not make the full-scope S0 gate cheap.

The unit graph is strict parity with the current legacy selector: **758 files = 25 root Vitest + 1 root `node:test` + 732 draft**, excluding draft `node:test`-style files and the frozen live-repo test. Root Node files execute after Vitest in their assigned cached shard. Four root shards use stable path hashes; four draft shards split by proof directory (technical, experience, epic, project). Production `packages/**` suites remain in Workspace tests, and `scripts/test/` remains in `test:scripts`. A shared turbo dependency runs the same 136 builds as the old pretest; exclusion-only inputs avoid hashing the root tree merely to track those dependencies.

`scripts/lib/unit-test-coverage.ts` proves exact set equality in both directions, rejects duplicate shard assignments, and verifies every selected file is in its shard's turbo inputs. The complete graph has 145 tasks: 136 builds, one dependency task, and eight test shards. Worker caps follow main's `min(configured, memory)` logic; turbo parallelism follows `HOBO_TURBO_CONCURRENCY`, and root workers honor `HOBO_TEST_MAX_WORKERS` then `HOBO_RELEVANT_CHECK_CONCURRENCY`.

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
