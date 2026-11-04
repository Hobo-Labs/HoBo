---
type: CI Performance Finding
title: "Finding 52: lease logs used the requested job after runner swaps"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 52: lease logs used the requested job after runner swaps

After the isolated worker restarted at 19:23 UTC on 2026-11-04, every memory-admission and work-directory-removal line carried `jobId=126808138878`, although GitHub showed different jobs running on those leases. The repeated identifier made independent jobs look like one stale reservation and hid which job actually owned memory and cleanup.

GitHub assignment was already recorded correctly. Poller ingress supplies the assigned job and runner name; the store matches that runner and sets `actualJobId`, while durable `jobId` deliberately remains the originally requested job for original-job requeue and backoff. The defect was the log projection: work-directory cleanup, OOM and orphan-lease events printed requested `jobId` directly. Orphan-container events had no job identity, and settlement had durable evidence but no worker log event. Event-log rebuild also restored a swapped lease's old requested-job key even though ordinary writes had been rekeyed.

Lease-scoped logs now use `actualJobId || jobId` and add `requestedJobId` only when the identities differ. Settlement uses the lease returned by the store, and orphan release uses the latest row read during reconciliation, so a concurrent assignment is not lost from cleanup logs. `hobo_ci_lease_settled` reports the same identity. Orphan-container removal and failure events look up the matching historical lease and omit job identity when no lease matches. SQLite event-log rebuild now restores the actual-job key as ordinary writes do.

Memory admission remains demand-scoped: ordinary queued demand logs its own job rather than falsely claiming an active lease's job. When the relay has an explicit swapped-lease mapping for that demand, admitted and waiting events carry the actual `jobId` plus the original `requestedJobId`. Durable requested identity is unchanged for requeue semantics.

Regression coverage asserts actual and requested identities for memory admission and waiting, work-directory removal, lease orphan release, historical container orphan removal and lease settlement. A relay test drives a known swapped lease through memory admission, and the existing store rebuild suite retains assignment markers and duplicate prevention. Tests also preserve original-job requeue and the rule that mismatched assignment is not an unassigned attempt.
