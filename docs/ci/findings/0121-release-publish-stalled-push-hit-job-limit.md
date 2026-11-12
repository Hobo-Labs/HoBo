---
type: CI Performance Finding
title: "Finding 121: release publish stalled push hit job limit"
description: "One job built and pushed all six release images; a silent hobo-cli push held it until the 20-minute limit cancelled the release, so no tag or GitHub Release was made."
tags: [hobo, ci, release, ghcr, timeout, matrix]
---

# Finding 121: release publish stalled push hit job limit

## Evidence

Release run [43144784243](https://github.com/Hobo-Labs/HoBo/actions/runs/43144784243), the first main-train release since `v0.0.0-alpha.2`, ended **cancelled**. The gate, all six "Build all OCI images" legs and Pages succeeded. **Publish GHCR images (tagged release)** (job `130955062368`, fleet box) ran from 03:38:44 to 03:58:59 and its **Build and push release images** step was cancelled at the job's 20-minute limit. Attest, the signed tag and the GitHub Release never ran.

The step's log, in order:

| Time (UTC) | What happened |
| --- | --- |
| 03:41:05 | `hobo-sdk` built (8 MB app layer); pushed by 03:41:09, base layers mounted from `hobo-ci-deps` |
| 03:41:23 | `hobo-codegen` built (162 MB); pushed by 03:41:32 |
| 03:43:06 | `hobo-cli` built (1.24 GB app layer); `docker push` started |
| 03:58:56 | cancelled, with no output from the push |

`hobo-codegen` uploaded about 20 MB/s, so the `hobo-cli` layer should have taken a minute or two. The push stalled, and it printed nothing because its output is captured (to look for retryable registry errors) and only printed once the push ends.

## Cause

- **One job did six images' work.** `push-release-ghcr-images.mts` built and pushed every image of the train in turn, so the job had to fit six builds and six pushes in 20 minutes. A single slow push used up all of it.
- **A push had no time limit of its own.** `runDockerPushWithRetry` retried a push that failed with a known registry error, but waited forever on one that never ended.

## Fix

- **One image per publish job.** `release-publish` is now a matrix over the release train's images. A small hosted job, `release-images`, lists them from the release ref (all six for `v*`, `hobo-sdk` for `sdk-v*`, `hobo-cli` and `hobo-mcp` for `cli-v*`), mirroring `releaseImageIdsForTrain`; a test pins the two together. A leg for an image outside the train would only be a run that could fail a release it has no part in, and an extra `release` deployment. One leg runs at a time, because legs on one box share the `*:candidate` tags. Each leg runs `push-release-ghcr-images.mts --image <id>`, which builds that image (and the images it is built from) and pushes it, and uploads `hobo-release-digest-<id>`. Should a leg ever run for an image its train does not ship, it writes an empty digest file. An image id the script does not know is an error, so a typo cannot pass as "not in this train".
- **Attest reads its own leg's digest.** `release-attest` runs over the same list; each leg downloads `hobo-release-digest-<id>` and skips, with a notice, when the file is empty. Before, every leg grepped one shared list, and on an `sdk-v` or `cli-v` tag the legs for images outside that train failed with "no digest", which blocked that train's GitHub Release.
- **Pushes are timed.** Each `docker push` attempt is stopped after 4 minutes and treated as retryable. All attempts together get 8 minutes: the `hobo-mcp` leg spends up to about 10 before its push (setup, up to 5 for the worker image, three builds), so the leg fails inside its 20 instead of being cancelled. The last attempt gets only what is left, and none starts with less than a minute left. A stalled attempt logs a warning with whatever the push printed, so the log shows which layer it was on. The step logs the push's start and how long it took. `HOBO_RELEASE_PUSH_ATTEMPT_TIMEOUT_SEC` and `HOBO_RELEASE_PUSH_BUDGET_SEC` override the two limits.
- **The box worker recognises matrix legs.** GitHub names a leg `<job name> (<value>)`. The box worker's storage-class and job-timeout tables are keyed by the job's name, so no leg of the build, attest or (now) publish matrix matched, and they got the default storage class and no workflow timeout floor. A lookup now tries the full name and then the name without its last parenthesised part.
- **The two image builds keep the 20-minute rule.** [Finding 113](0113-main-ci-starved-by-cancel-in-progress.md) had raised `ci-runner-image` in `hobo-ci.yml` to 30 minutes and the deps publisher's `runner-image` job to 40, which `scripts/test/workflow-job-timeouts.test.ts` rejects. Both are back to 20. The `hobo-ci.yml` build step gets 15 of them and the publisher's build 15 (`HOBO_CI_WORKER_BUILD_BUDGET_SEC=900`), leaving room for its push. A build that cannot finish in that fails loudly; the answer is a faster build, not a longer job.

## Verified

- `scripts/test/push-release-ghcr-images.test.ts`: a stalled push is stopped and retried; the last attempt gets only what is left of the budget; no attempt starts with under a minute left; once the budget is spent the error names the stall; a run that both timed out and exited 0 is retried as a stall. The `release-images` lists match `releaseImageIdsForTrain` for every train. `releaseImagesToPublish` returns the named image, none for an image the train does not ship, and refuses an unknown id. The workflow test pins the publish and attest matrices, the per-image artifact and the attest skip.
- `packages/ci-gh-actions/test/storage-job-classes.test.ts` and `workflow-job-timeout.test.ts`: matrix legs get their job's storage class and timeout; `Publish GitHub Pages (site/)` still matches exactly.
- `scripts/test/workflow-job-timeouts.test.ts` passes (it failed on `main` for the two image jobs).

## Not changed

- The `hobo-cli` image carries a 1.24 GB application layer. A smaller layer would push faster; that is a separate change to what the image stages.
- Attest legs now count as the `light` storage class on fleet boxes, as the table always intended, and build legs as `runner_image`; before, no matrix leg matched and all got `standard`. This changes admission reserves only.
- The worker-image builds get 15 minutes, which is about what a cold build without box cache takes. One that runs over fails loudly; the fix then is a faster build, since the 20-minute rule stands.
- Whether the stall was GHCR, the box's uplink or the Docker daemon is unknown, because the push printed nothing. The next stall's warning carries the push's own output.
- A re-run of the cancelled run uses the old single-job definition. The next green main run releases with this one, and it measures from `v0.0.0-alpha.2` ([`docs/release/pipelines.md`](../../release/pipelines.md)), so nothing is skipped.
