---
type: CI Performance Finding
title: "Finding 157: release publish critical path"
description: "The release median is 691 s and the deps publisher median is 949 s. OCI matrix legs were serialized by shared candidate tags, main-train builds lacked a last-release Turbo base, and deps cache export rebuilt the image after its push."
tags: [hobo, ci, performance, release, npm, oci, deps-image, cache, parallel]
---

# Finding 157: release publish critical path

## Measurements

The orchestrator sampled the last 20 completed runs on 2026-11-20. Component times are observed critical-path times, not medians over separate component samples.

| Workflow or component | Wall time |
| --- | ---: |
| HoBo release (npm + GHCR OCI), median | 691 s |
| CI deps image publisher, median on `hobo-trunk` | 949 s |
| `release-hobo-integration` | 366 s |
| `release-contract` / affected OCI | 237 s |
| Release Freight realize proof | 102 s |

The deps publisher remains dominated by its image build and push. Its existing GHCR manifest check and local key checks already skip unchanged images; [finding 153](./0153-deps-build-window-release-image-gc-and-leaner-release-contexts.md) bounds the build window, disk use and release build context.

## Critical path

For a main-train release, routing and the version/scope gate fan out into the shared CLI build, OCI build gate, slow integration gate and Pages freshness work. GHCR publish waits for the CLI build, OCI build gate and integration gate; npm publish waits for the same release gates but runs beside GHCR publish. Each GHCR publish leg then feeds attestation. The signed tag and GitHub Release wait for GHCR publish, npm when enabled, attestation and the Pages gate result, with `release-tag` still protected by `environment: production`.

Before this change, the OCI build and publish matrices each ran one image at a time, so their wall time was the sum of their legs. Attestation was also serial. The measured 366 s integration gate can hide shorter parallel work, but it cannot hide OCI legs queued behind one another after that gate. The deps publisher has a narrower serial path: worker-image publication, deps build on a confirmed miss, image push, then a second Docker build whose purpose was only registry-cache export.

## Ranked wins

1. **Parallel OCI build, publish and attest legs — implemented.** `release-oci-build-tag`, `release-publish` and `release-attest` allow six legs. `HOBO_RELEASE_CANDIDATE_SUFFIX` namespaces every local candidate tag by workflow run, attempt and matrix image, including the SDK and CLI prerequisites of the MCP leg. `HOBO_RELEASE_STAGING_ID` also namespaces shared-store staging by run, job, attempt and matrix image. This removes the tag and staging collisions that required [finding 121](./0121-release-publish-stalled-push-hit-job-limit.md)'s serial matrices while preserving one 20-minute budget and one digest artifact per image. The expected improvement is from the sum of independent legs toward the slowest leg, subject to runner admission and registry throughput; it is not a new measured median yet.
2. **Skip unchanged source work in main-train OCI builds — implemented.** The main gate now exports the last release tag it already finds. OCI build and publish jobs fetch the commit history without blobs and pass that tag through the existing `HOBO_RELEASE_TURBO_BASE` / `releaseOciTurboBuildArgs` path. Turbo can omit unchanged unrelated workspace tasks while the image filter still materializes the selected image closure. Independent tag and dispatch releases keep the full-closure behavior. npm does not drop unchanged packages from publication: the fixed train gives every allowlisted package the new semver and mapped workspace dependencies reference that semver.
3. **Export the deps registry cache in the initial build — implemented.** On a publisher cache miss, `build-deps.sh` adds `--cache-to …,mode=min` beside the existing `--cache-from`. The publisher skips its post-push cache-only rebuild only when that fresh containerd build exported the cache. Local-image hits retain the old export fallback, classic Docker storage retains its explicit skip, and pull-request builds still have no registry write permission.
4. **Reuse immutable published artifacts — already present, retained.** GHCR publish reuses a tag only when its revision and release labels match ([finding 138](./0138-release-attest-missing-digest-after-cancel.md)); deps publish skips an existing content-keyed manifest. These checks avoid rebuilding identical artifacts without weakening digest verification or attestation.
5. **Keep non-gating work off the post-merge critical path — retained.** Pages freshness is independently gated, deps publication is non-blocking, and main CI can reuse a green merge-queue tree ([finding 154](./0154-main-waited-for-runners-between-jobs.md)). The 366 s release-integration suite remains a publish gate, now scoped on pull requests by [finding 155](./0155-merge-queue-vitest-file-shards-and-release-integration-lane.md); moving it after publication would reduce wall time only by weakening the release contract and is not part of this change.

## Safety boundaries

- The `release` and `production` environments, signed-tag path, npm provenance, OCI digest checks, provenance attestation and SBOM attestation are unchanged.
- The `merge_group` trigger and release PR gate are unchanged. `release-realize` stays on `pull_request` and `merge_group` as an offline proof; publish jobs stay behind the main-train gate, tags, or dispatch, with workflow tests pinning job-level `if` conditions.
- A failed matrix leg still fails its workflow stage; `fail-fast: false` only lets independent legs finish.
- No Vercel Git link or relay deployment path changed.

## Verification and next measurement

The focused contracts cover candidate-tag isolation and invalid suffixes, MCP's namespaced CLI marker, parallel workflow wiring, last-release output propagation, registry-cache export and existing publish reuse. The changed shell scripts pass `bash -n`; the staged relevant gate and workflow lint cover the complete diff.

After this reaches `main`, compare the next 20 completed runs against 691 s and 949 s. Record per-leg start/end times to separate actual build/push savings from runner admission. Until that production observation exists, the speedup is structural and bounded by the old serial shape, not a claimed new median.

The new `turbo_base` job-output channel is **built, not proven in production**. The first main-train release after merge must show the gate's previous-release tag reaching both OCI jobs' `Fetch previous release for affected builds` steps; link that run here as the channel observation.
