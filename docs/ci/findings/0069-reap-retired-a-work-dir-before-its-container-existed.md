---
type: CI Performance Finding
title: "Finding 69: Reap retired a work dir before its container existed"
description: "A stale lease snapshot let storage reaping retire a newly prepared job directory before Docker created its container, causing runner EACCES failures."
tags: [hobo, ci, performance]
---

# Finding 69: Reap retired a work dir before its container existed

## Evidence

Production box-worker jobs failed about **2 seconds** into execution with `EACCES` on `/opt/actions-runner/_hobo_work/_tool`. The runner executes as uid 1000, but the bind-mounted work directory had been recreated by Docker with root ownership.

## Cause

Container launch reserves a lease, prepares `hobo-<lease-id>` with uid 1000 ownership, and only then calls `docker create`. Storage reaping protected only leases from a snapshot supplied by its caller, then used container existence to protect every other job directory. The relay could take that snapshot at the start of a dispatch pass and run maintenance minutes later; daemon GC similarly read leases before the rest of maintenance. A second worker during handoff shares the same store and work root.

A lease reserved after the snapshot, whose directory had been prepared before its container existed, therefore had neither form of protection. Reaping retired the directory, Docker recreated the missing bind source as root, and the uid 1000 runner could not create `_tool`.

## Fix

Reaping now lists job directories first and then reads the lease store afresh. Because a lease is persisted before its directory is created, that read covers every listed directory whose lease remains active. Both `hobo-<lease-id>` and the lease sandbox name are protected regardless of lease state, including reserved, dispatching, dispatched, claiming, running and uncertain leases. A failed fresh lease read logs `hobo_ci_storage_prune_failed` with `operation: "read-leases"` and retires nothing.

The relay also re-reads active leases immediately before each storage-admission call, rather than passing the dispatch-pass snapshot. Existing retirement and retired-directory sweeping behavior is unchanged.

## Verification

Unit tests cover a lease appearing after the directory listing, dispatching or claiming leases without containers, a failed lease read, and the relay's fresh lease read before admission.

No box deploy or live CI run was performed for this finding.
