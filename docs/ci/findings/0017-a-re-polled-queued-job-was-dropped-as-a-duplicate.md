---
type: CI Performance Finding
title: "Finding 17: a re-polled queued job was dropped as a duplicate"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 17: a re-polled queued job was dropped as a duplicate

The poller uses constant `poll-<job>-<attempt>-q` delivery ids for unassigned queued jobs.
Once accepted, later polls returned `duplicate` without checking whether a pending job or active lease still covered the job.
Run 41738569286 had five jobs queued for over 17 minutes and logged as duplicates while 22–24 jobs waited.
The fix checks coverage locally and re-admits uncovered jobs through the relay at most once per minute per delivery id.
The Vercel relay webhook answers 202 `requeued` for such a re-admitted delivery.
