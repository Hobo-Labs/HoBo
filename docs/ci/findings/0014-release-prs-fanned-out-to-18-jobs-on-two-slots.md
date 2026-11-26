---
type: CI Performance Finding
title: "Finding 14: release PRs fanned out to 18 jobs on two slots"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 14: release PRs fanned out to 18 jobs on two slots

#1674 added the release pipelines. Its PR queued 18 `hobo` jobs between them:
- `release-code` queued contract, lint, a build cone, four Vitest shards, affected-image selection, and one image job.
- `release-hobo` queued contract, affected-image selection, and seven image jobs. `hobo-code` was again among them, so it was built in both pipelines.

Every job paid about 70 s of checkout and 20 to 40 s of install before its real work. That work was 13 to 18 s of tests per shard and 20 to 65 s per image. The old detector also selected every image on any lockfile, root `package.json` or `turbo.json` change.

| #1674 (before) | wait for a slot | run |
|---|---:|---:|
| release-code lint / contract / cone | 153 / 198 / 502 s | 96 / 105 / 112 s |
| release-code shards 1 and 4 | 130 and 295 s | 115 and 121 s |
| release-code shard 2 | — | 6.5 min in checkout, cancelled |
| release-code shard 3 and image | never got a slot | cancelled |
| release-hobo contract / affected | — | 122 / 58 s |
| release-hobo sdk / codegen | 397 / 746 s | 132 / 101 s |
| release-hobo remaining images | — | cancelled at about 1316 s |
| merge-queue contract guard (run 41711566157) | 636 s | 119 s |

Fix (#1685):
- **Affected images keyed by build inputs.** `scripts/ci/release-oci-affected.mts` hashes, for each image:
  - the tracked build files of its package's workspace closure, read from `pnpm-lock.yaml`, with tests and docs excluded;
  - that closure's slice of the lockfile;
  - the shared release and toolchain inputs;
  - its own manifest entry and any extra path-read inputs;
  - the key of its `FROM` image.
- **One PR job per pipeline.**
  - `release-hobo` builds its affected images in sequence, running the live OCI contract on each.
  - `release-code` runs lint, the unsharded `@hobo/code` suite through turbo, and the `hobo-code` image.
  - `hobo-code` is built only by `release-code`.

| #1685 (after; its workflow edits force every image) | wait for a slot | run | jobs |
|---|---:|---:|---:|
| release-code (`code-release`) | 12 s | 145 s: install 21 s, full suite 70 s (204 files, 5,990 tests), image 25 s | 1 |
| release-hobo (`release-contract`) | 253 s | 229 s: 6 images and 6 live contracts in 176 s | 1 |

Slot-time for the same work dropped from more than 1,100 job-s, much of it never finished, to 374 s. The job count dropped from 18 to 2. Both runs finished, in 158 s and 483 s of wall time, where #1674's were cancelled after more than 20 minutes. A PR that changes no image inputs now runs the contract tests and the suite only. The suite's turbo entry lands in the shared cache, so main's S0 lane can replay it. The 253 s wait was for slots held by other PRs' fabric jobs. That PR's own fabric run still waited 82 to 937 s, so slot count remains the next limit. More slots are not free: the host has 15 GiB, runs 2 slots × 6 GiB, and has peaked near 12 GiB (item 5 of "What is left to reach five minutes").
