---
type: CI Performance Finding
title: "Finding 16: merge_group skipped the gate that caught the red main"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 16: merge_group skipped the gate that caught the red main

Run 41736273918 went red after #1689 merged through the merge queue. Main full gate's Workspace tests
caught a latent `@hobo/stations` fixture break introduced by #1631 and fixed by #1692. The PR impact gate
ran only turbo `test:unit` lanes, while `merge_group` ran just the contract guard among the affected CI
jobs; Main full gate neither ran on `merge_group` nor was required. Merge-group entries now run the same
affected S0 and dependent workspace-test gate as Main full gate inside the required PR impact gate, using
the merge group's base SHA. The PR impact gate requests `hobo-trunk` by default on `merge_group`, while
its `pull_request` runs continue to request `hobo`.
