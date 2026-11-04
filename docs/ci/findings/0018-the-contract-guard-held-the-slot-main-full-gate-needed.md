---
type: CI Performance Finding
title: "Finding 18: the contract guard held the slot Main full gate needed"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 18: the contract guard held the slot Main full gate needed

Main push run 41747634569 took 109 s: image 00:33:06–00:33:12, contract guard 00:33:06–00:33:44, Secret scan 00:33:24–00:33:39, Main full gate 00:33:45–00:34:37.
The gate was runnable at 00:33:12 but waited 33 s for one of two slots; the guard's real work was 2 s and its other ~33 s duplicated checkout, preflight and install.
The guard now runs only on pull requests, while its two steps run after install in Main full gate and in PR impact gate on merge_group.
The PR-only guard requests plain `hobo`.
Expected saving: about 33–38 s of critical path on a main push and on merge_group.
