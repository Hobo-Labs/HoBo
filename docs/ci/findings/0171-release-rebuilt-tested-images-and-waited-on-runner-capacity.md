---
type: CI Performance Finding
title: "Finding 171: release rebuilt tested images and waited on runner capacity"
description: "A main release took 57 minutes 6 seconds from CI creation to failed CD completion; OCI images were built again after their gates and long runner waits consumed the complete ten-minute budget."
tags: [hobo, ci, cd, performance, cache, ghcr, npm]
---

# Finding 171: release rebuilt tested images and waited on runner capacity

## Baseline

For commit `4a898a894ba0ae51f397abbdf991fac5ab035adf`, [CI run 45681098034](https://github.com/Hobo-Labs/HoBo/actions/runs/45681098034) began at creation time 19:01:52 UTC and finished at 19:16:58 UTC on 2026-11-25. The subsequent [release run on the same commit 45683649472](https://github.com/Hobo-Labs/HoBo/actions/runs/45683649472) ended at 19:58:58 UTC with failure: 3,426 seconds from CI creation. The run timestamps and matching commit identify this as the observed pair; the workflow event payload was not retained to independently confirm its triggering run. CLI, MCP, and codegen GHCR publishing failed; npm, attestations, and the final signed release were skipped. This is a failed baseline, not a successful warm-cache deployment.

CI reported 175 of 175 Turbo tasks cached, but image build logs showed mixed cache hits and misses. CI waited 10 minutes 58 seconds before its first job started; CD waited another 6 minutes 59 seconds before its first job. These are observed pre-job intervals, not a proven diagnosis of the scheduler.

The CLI image gate spent 137 seconds resolving its toolchain, 565 seconds on the SDK prerequisite, and 327 seconds on the CLI image build and verification. Publishing waited for all image gates and rebuilt the image. The SDK publish job spent 108 seconds installing dependencies, 494 seconds rebuilding and publishing, and 100 seconds uploading its journal. Large Freight artifacts for the site and CI-serve jobs were approximately 952 MB and 944 MB.

The later [CI run 45697737707](https://github.com/Hobo-Labs/HoBo/actions/runs/45697737707) finished successfully, but its [release run 45698684928](https://github.com/Hobo-Labs/HoBo/actions/runs/45698684928) waited 10 minutes 23 seconds before its first routing job. The ten-minute CI-to-CD budget was already exceeded before that job began.

The subsequent release run finished cancelled at 22:34:45 UTC, 6,654 seconds (1 hour 50 minutes 54 seconds) after CI creation. Its MCP image gate ran from 21:27:23 to 21:47:42 UTC and was cancelled; GHCR publishing, npm, and attestations were skipped; Pages started at 22:17:24 UTC and failed at 22:34:44 UTC with rollout-progress-deadline and rollback-no-predecessor. The MCP gate was cancelled during the CLI prerequisite; its log does not state why. It warned that the previous alpha tag was unreachable, so staging fell back to the full deployable closure. This failed run already avoided the larger changed-range union; removing that union does not explain or fix its duration by itself. Its image logs were mixed: MCP showed 102 hit and 109 miss lines, codegen 0 hits and 34 misses, CLI 217 hits and no misses, and SDK 102 hits and no misses. These are log-line counts, not unique task counts.

## Experiments and remaining work

A candidate passes the verified OCI layout from build to publication and rechecks every referenced digest and image identity before use. Unit tests reject missing or changed blobs, wrong revision, wrong version, and mismatched existing tags. This is not yet a performance champion: image-layout transfer and full end-to-end Docker or Actions timing have not been measured.

The SDK packaging prototype preserves existing workspace import names through npm aliases. A real pack and clean install of a fixture passed, but the actual SDK runtime dependency closure includes private and unmapped packages and is not yet publishable. The staging guard fails before building when a runtime workspace dependency has no public mapping. It must not be represented as a successful SDK release.

Anonymous GHCR token requests for the published SDK, site, and CI-serve paths returned HTTP 401 while a public control succeeded. Authenticated publish success does not prove anonymous image availability. A new anonymous manifest check verifies the exact digest; a manifest check alone does not verify every layer.

A later local SDK staging candidate built and packed all ten allowlisted packages in 206.202 seconds after a lockfile change, then in 102.676 seconds on a warm repeat with all 51 Turbo tasks cached. The two runs used the same version and worktree and produced matching SHA-256 hashes for all ten tarballs and the same manifest. The helper changes were uncommitted, so their revision metadata did not uniquely identify the source; these are local experiment timings, not revision-bound artifacts. These timings cover SDK staging on the sandbox only; they do not measure CI, images, registry publication, or deployment.

A history-deepening prototype made the prior release tag reachable but expanded the existing separate Turbo filters as a union. In a fresh clone of the recorded 480-commit range, the union contained 834 graph entries, but 659 were non-executing `<NONEXISTENT>` entries: 175 build tasks ran versus 115 in the deployable closure. Two fully warm local repeats took 1.429 and 1.326 seconds for the union and 1.069 and 1.068 seconds for the closure, with every executed task cached. This is a small local Turbo improvement, not an end-to-end release result; the failed release already used the closure fallback.

A non-equivalent local cache experiment used the real staged 156 MB codegen context and unchanged Dockerfile with a public Node base in place of the inaccessible private toolchain. A fresh BuildKit build took 20.618 seconds; the warm rebuild took 1.728 seconds with four cached steps and the same manifest digest. The experimental image was loaded into rootless Docker and exported through the release code using Docker save; its labeled OCI layout passed the handoff verifier, and a modified referenced layer was rejected. This excludes staging, CI, publication, and the production toolchain and does not establish a release-gate time. The unmodified local gate failed after 22.066 seconds because the rootless daemon could not fetch the Dockerfile frontend; the pinned GHCR toolchain also returned anonymous HTTP 401.

Candidate results must be replayed against this baseline and then against each verified champion. Count the whole interval from CI creation to final CD completion, include waits, require all expected deployments to execute successfully, and record warm-cache evidence for each deployable. A skipped publish or unverified cache is not a pass.
