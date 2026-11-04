---
type: CI Performance Finding
title: "Finding 56: the monolithic deps push held main after its gate passed"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 56: the monolithic deps push held main after its gate passed

Main push run **41853973126**, after **#1712**, built and locally promoted `hobo-ci-deps:ve9efb8bcd14c-fe5f1b036d961a2e` in **2m09s**. `Main full gate` passed in about **1m30s**, but `CI deps layer (pnpm)` then spent **8 minutes** in `Push deps image to GHCR` at near-zero throughput before the run was cancelled. Base layers were mounted from `hobo-labs/hobo/hobo-ci-worker`; the stuck payload was the single `COPY --from=install … /deps/` layer containing all `node_modules`. That tree was about **3.0 GB uncompressed** with **2,006 `.pnpm` entries**, and the image was **5.27 GB**. One registry upload, not the build or gate, made main red and slow.

Main push run **41900082129**, after **#1711**, took **306 s**, versus **99–103 s** before. `Main full gate` itself ran **19:48:05–19:49:37**. The remaining wall time came from `CI deps layer (pnpm)`: `Build deps image and verify offline install` took **148 s** (BuildKit `pnpm fetch` **19.3 s**, offline install **64.7 s**, final `COPY` **23.2 s**, layer export **18.6 s**, verification **6 s**), followed by a blocking `Push deps image to GHCR` that took **125 s**.

The fabric job no longer logs into or pushes GHCR. `ci-deps-publish.yml` starts after a successful main fabric run or on manual dispatch, checks out the completed run's commit, and computes the same deps key. It skips when neither `hobo-ci-deps:<key>` nor a matching `:local` exists, skips an existing remote manifest, and otherwise pushes with a **five-minute job timeout** and **240-second command timeout**. Its concurrency group cancels superseded publishers. A timeout or registry failure is confined to that workflow and cannot block or fail HoBo CI. A keyed local hit is retagged and promoted without rebuilding; a matching `:local` restores a pruned keyed tag; a GHCR hit still pulls instead of building.

The final image now has **64 independent bucket layers plus one residual layer**. `scripts/ci/deps-layer-buckets.mts` assigns each content-keyed `.pnpm` entry by SHA-256 of its name, so unchanged packages stay in the same bucket and adding an entry changes only that bucket. The Dockerfile section is generated and drift-tested. Sorted entries, fixed ownership, a fixed zero epoch (rather than commit-time mtimes) and optional buildx `rewrite-timestamp=true` provide reproducible inputs while preserving every path jobs consume. Subsequent lockfile changes should upload only changed buckets and the small metadata layer, not another monolithic 3 GB payload.

A clean offline install also tested `pnpm.supportedArchitectures.libc: ["glibc"]`. It did **not** exclude `@rivetkit/engine-cli-linux-x64-musl` (**85 MB**): that package declares `os` and `cpu` but no `libc`, and its static musl binary can be intentional on a glibc host. The architecture setting was therefore left unchanged rather than claiming a size cut that did not occur or dropping a runtime package without evidence.

Expected effect: main's critical path contains no registry push, and later dependency changes push only changed buckets. This sandbox has no Docker daemon, so cache-off layer-digest equality, actual per-bucket compression and push sizes, and end-to-end offline-install verification must still be confirmed on the self-hosted box.
