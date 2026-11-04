---
type: CI Performance Finding
title: "Finding 51: requeued leases renewed phantom memory grace"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 51: requeued leases renewed phantom memory grace

On 2026-11-04 the isolated worker twice logged `hobo_ci_memory_without_containers inUseMb=6144 activeLeaseCount=1`. No worker container existed, but one heavy 6144 MiB reservation remained against the 13954 MiB admission budget, leaving room for only one more heavy job. This followed finding 45's 12288 MiB stale-reservation incident and showed that #1718's reconciler did not eliminate the whole class.

The remaining loop crossed two components. Reconciliation cancelled a missing-container lease and requeued its job, then the relay's admission pass in that same tick immediately reserved a replacement with a new UUID and a new `createdAt`. Empty Docker inventory therefore produced an endless sequence of individually young reservations: each reconciliation released the old row, each admission recreated its memory, and `hobo_ci_memory_without_containers` returned on the next tick. Unassigned-runner backoff reduced the common case but did not cover an already attributed lease.

Memory admission also summed every active lease in a shared store, while reconciliation inspected only isolated-container offers owned by the local `providerAccountId`. A Vercel lease, another worker's lease, or worker-configuration skew could therefore consume local Docker memory without ever appearing in the local Docker inventory or reconciliation set. All six active lease states were already inspected when ownership matched; there was no additional state-specific omission.

Missing-container requeue now writes a durable `requeueAfter` fence one orphan-grace interval ahead. Every store refuses reservation before that timestamp, and the relay skips delayed demand before memory accounting or trunk capacity recovery. The tick that releases a reservation cannot recreate it. Once the fence expires, the retry receives one fresh bounded reserve-to-create window rather than starving forever. Memory admission now uses the same worker-ownership key set as reconciliation, so foreign leases neither consume local memory nor trigger the local no-container diagnostic.

Terminal `completed` and `cancelled` rows retaining `memory_mb` are harmless because active-lease queries filter them out. Trunk accounting adds only the unused portion of its standing reservation, not a second copy of trunk lease memory. The default daemon supplies a work root and does not prewarm, so its warm-memory counter cannot be the box's phantom 6144 MiB lease. Unknown Docker inventory remains fail closed: listing failure releases and removes nothing.

Regression coverage drives the real SQLite store, relay runtime, memory admission and lease reconciler against fake empty Docker inventory for two consecutive ticks. It asserts no replacement lease, no renewed memory admission and no second no-container diagnostic. A second integration test proves another worker's heavy lease does not block local admission. Store-contract tests pin the durable fence and the fresh grace window after it expires; existing tests retain reservation grace, all-state release and unknown-inventory fail-closed behavior.
