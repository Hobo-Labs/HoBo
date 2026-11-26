---
type: CI Performance Finding
title: "Finding 24: slot-only admission let the host OOM killer choose a victim"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 24: slot-only admission let the host OOM killer choose a victim

PR #1697's **CI fabric contract guard** died in `pnpm install` with exit 137 while neighbouring jobs ran; #1696's merge-queue run died in **Workspace tests**. The 16 GiB, no-swap box admitted three containers with an 8192 MiB Docker limit each: `3 × 8192 = 24576 MiB`, already above physical RAM before the daemon, Docker and page cache. Per-container limits did not bound their sum, and workflow heap settings did not bound the number of Vitest forks.

One class model now supplies both the admission request and the container's hard `--memory` and `--memory-swap` values. The default budget is `min(os.totalmem(), numeric /sys/fs/cgroup/memory.max) - HOBO_CI_WORKER_MEMORY_RESERVE_MB`. The reserve is at least 2048 MiB. An explicit `HOBO_CI_WORKER_MEMORY_BUDGET_MB` may lower, but never exceed, host/cgroup memory minus that reserve. Startup fails closed unless every general class fits outside the trunk reservation and the heavy trunk class fits the full budget.

| Class | Default hard memory and memory-swap | Node heap per process | Max Vitest workers | Exact-name assignments |
|---|---:|---:|---:|---|
| `light` | 3072 MiB | 1152 MiB | 1 | CI fabric contract guard, Secret scan, static release contracts and attest jobs |
| `standard` | 4096 MiB | 1664 MiB | 1 | the default for every unlisted job and the pre-warmed container |
| `heavy` | 6144 MiB | 1344 MiB | 3 | turbo build/test gates, OCI image jobs, the pricing gate and clean/Dagger bootstraps |

`HOBO_CI_WORKER_MEMORY_CLASS_<LIGHT|STANDARD|HEAVY>_MB` overrides a class; heavy also accepts the legacy `HOBO_CI_WORKER_MEMORY_MB` alias. Classes below 3072 MiB are rejected. The exact GitHub job name selects the class, and the admitted request is persisted on the lease and exported as `HOBO_CI_JOB_MEMORY_MB`. Active and reserved leases, legacy leases counted as heavy, and the warm container all consume the same budget. An active trunk lease replaces its reservation; warm admission cannot spend that reservation.

The incident box reports **15989 MiB**. With three slots and the default 2048 MiB host reserve:

- admission budget: `15989 - 2048 = 13941 MiB`;
- one heavy, one standard and one light container: `6144 + 4096 + 3072 = 13312 MiB`, leaving `629 MiB` of admission budget, so three mixed slots fit;
- two heavy containers: `2 × 6144 = 12288 MiB`, leaving `1653 MiB`, so even a 3072 MiB light third job waits;
- three heavy containers would need `18432 MiB`, exceeding the budget by `4491 MiB` before the host reserve.

Thus three slots never admit a set whose summed hard limits exceeds **13941 MiB**. The box can run three mixed-class jobs, but not three heavy jobs. A smaller job may backfill behind a non-fitting head job for 60 seconds (`HOBO_CI_WORKER_MEMORY_HOL_MS`) before the same rank waits behind it too. `hobo_ci_memory_admission_wait` / `hobo_ci_memory_admitted` expose the arithmetic; Docker-confirmed exit-137 OOM kills log `hobo_ci_container_oom` with the class.

Before install, `scripts/ci/memory-env.mts` reads the job cgroup limit, then `HOBO_CI_JOB_MEMORY_MB`, then host RAM. It writes `HOBO_NODE_OPTIONS=--max-old-space-size=<heap>` (GitHub blocks `NODE_OPTIONS` in `$GITHUB_ENV`), `HOBO_TURBO_CONCURRENCY=1`, and the repo-owned `HOBO_TEST_MAX_WORKERS`. The daemon independently computes the same heap from the admitted memory class and injects `NODE_OPTIONS` at container creation, so it reaches every Node process; workflows do not override it with a static value. A 768 MiB native/non-heap allowance leaves `limit - 768` for the turbo/Vitest parent and its workers: `workers = max(1, min(cpuCount, floor((limit - 768) / 1280) - 1))`, then `heap = min(3072, floor((limit - 768) / (workers + 1)))`. Therefore `(workers + 1) × heap + 768 <= limit`, including the parent heap. CI does **not** export `VITEST_MAX_WORKERS`: Vitest applies that variable after config, including after `fileParallelism: false`, overriding correctness-critical single-worker pins. `scripts/ci/vitest-max-workers.mts` instead resolves `min(configured cap, HOBO_TEST_MAX_WORKERS)`, and a config scan executes every single-worker config under the CI environment.

The daemon also defaults **`HOBO_CI_WORKER_MERGE_GROUP_LEASES=1`** and rejects zero or invalid values. It counts reserved and running merge-group leases by cached run event, leaves excess jobs queued with one `hobo_ci_merge_group_cap_wait` log per job, and admits them in order as capacity frees. Set the repository merge queue's **maximum pull requests to build** to **1** as the outer bound as well.
