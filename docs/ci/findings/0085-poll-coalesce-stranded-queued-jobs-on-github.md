---
type: CI Performance Finding
title: "Finding 85: poll coalesce stranded queued jobs on GitHub"
description: "Duplicate poll ingests backed off coalesce forever; jobs stayed queued on GitHub with waiting result coalesced."
tags: [hobo, ci, worker, polling]
---

# Finding 85: poll coalesce stranded queued jobs on GitHub

## Evidence

After `3f40fbd3`, the box worker's poll logs showed dozens of waiting jobs as `coalesced` (including **CI runner image (mise oci)** job `129978990227`), queued on GitHub since ~10:51 CST while the worker idle-polled.

## Cause

`poll-ingest-coalesce` treated **`duplicate`** as a quiet ingest result and stopped re-ingesting the same queued job for up to five minutes per streak. When the durable inbox already held the delivery but nothing covered the job in pending/active leases, poll never reached `hosted-runtime`'s duplicate **requeue** path often enough. Backoff renewal left GitHub jobs **queued forever**.

## Fix

- Stop coalescing on `duplicate` (only true quiet waits backoff).
- Force poll ingest when GitHub `created_at` age exceeds coalesce `maxMs`.
- On duplicate recheck failure, return **`requeued`** instead of `duplicate`.
