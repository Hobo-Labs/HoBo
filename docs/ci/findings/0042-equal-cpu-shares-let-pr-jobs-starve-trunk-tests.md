---
type: CI Performance Finding
title: "Finding 42: equal CPU shares let PR jobs starve trunk tests"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 42: equal CPU shares let PR jobs starve trunk tests

On 2026-11-04, #1710's merge-group **PR impact gate** ran from **15:39:44Z to 15:42:55Z**. At **15:40:54Z**, eight #1709 PR jobs started on the same four-CPU box: **Release contract**, **CI fabric guard**, **CI runner image**, **off-path checks**, **secret scan**, **artifact signing**, **cold loop**, and **HoBo Code**. The merge-queue/main failures included **@hobo/pricing design-scorecard**, **@hobo/cli codegen-app-compilation starter cases**, and **@hobo/hobo auth-md-state-concurrency** at its unchanged 10 s test timeout. The last test's body takes about **115 ms locally even under six CPU hogs**, so a test-code timeout increase would hide host contention rather than fix it.

Admission already ordered waiting jobs trunk-first, but every running container received equal CPU and IO scheduling. The relay now passes the planned job's admission rank to the isolated host and Docker spec. Rank 0 (`merge_group`, `push`, and `workflow_dispatch`, including the trunk-label fallback) creates containers with **`--cpu-shares 8192`**; other ranks use **512**. Docker maps these relative shares to cgroup v2 `cpu.weight` where applicable. With one trunk and one PR container on the four-CPU box, the 16:1 ratio gives trunk about **94.1%** of their combined CPU allocation instead of 50%, while still allowing the PR to make progress. These are relative weights, not CPU quotas.

The same classes request **`--blkio-weight 800`** for trunk and **200** for other jobs, a 4:1 IO preference within Docker's valid 10–1000 range. The first weighted create or update probes engine support once per daemon process. If the engine or cgroup rejects block IO weighting, the driver emits one `hobo_ci_blkio_weight_unsupported` event, disables only that flag for later operations, and retries with the validated CPU weight. IO weighting is therefore best-effort and never blocks a job launch. Warm containers start at PR weight because their lease is unknown; assignment now calls `docker update --cpu-shares … --blkio-weight …` before the rename, so a trunk job cannot inherit the warm container's low weight.

While any trunk lease is active, admission also allows at most **`HOBO_CI_WORKER_PR_CAP_WITH_TRUNK=1`** active non-trunk lease by default. This bound applies to new reservations, never stops running PR work, and disappears completely when no trunk lease is active. On the four-CPU box, one PR alongside trunk avoids splitting the PR share across another flood of jobs; zero pauses new PR admissions during trunk work, and values through eight are accepted as strict decimal integers. Existing trunk-first ordering, memory classes, merge-group caps, and slot lending remain unchanged. Cap waits log `hobo_ci_memory_admission_wait` with `reason=trunk-pr-cap`.

Unit coverage uses the memory GitHub/store and fake Docker drivers to pin high trunk and low PR weights, warm-spare reweighting, one-time IO fallback, strict environment parsing, and the capped/uncapped admission transition. The scheduling effect is observable only on the box **after the worker daemon is redeployed and launches or reassigns containers**; this change does not claim a live-box timing result by itself.
