---
type: CI Performance Finding
title: "Finding 138: release attest missing digest after cancel"
description: "Release run 43176733275 attest legs for hobo-codegen and hobo-sdk failed with an empty per-image digest artifact when GHCR already held the tag from cancelled run 43164708200."
tags: [hobo, ci, release, ghcr, attest, digest]
---

# Finding 138: release attest missing digest after cancel

## Evidence

Release run [43176733275](https://github.com/Hobo-Labs/HoBo/actions/runs/43176733275) on `f2bd06ddf` greened publish but **Attest GHCR images** legs for `hobo-codegen` (job `131078818104`) and `hobo-sdk` (job `131078818201`) failed with `no digest for <id> in …/hobo-release-digest.txt`. Those tags were already on GHCR from the superseded/cancelled train run [43164708200](https://github.com/Hobo-Labs/HoBo/actions/runs/43164708200), so the matrix legs could finish publish without recording a digest line attest could grep.

## Cause

`push-release-ghcr-images.mts` only appended digests after a local build and `docker inspect`. A registry-only tag (or a push that left `RepoDigests` empty locally) yielded an empty artifact while the attest matrix still listed every train image.

## Fix

- Before building, resolve an existing GHCR tag with `docker buildx imagetools inspect` (including its capital `Digest` field), then always verify labels via `docker pull` of the immutable `name@sha256:…` ref (never the mutable tag alone).
- Fail closed unless `org.opencontainers.image.revision` (and version when present) matches `HOBO_RELEASE_REVISION` for this run.
- Write a normalized `ghcr.io/.../<image-id>@sha256:…` line either from reuse or after push, with registry fallback when local inspect is empty.
- Attest legs error on an empty digest artifact instead of treating it as “not in train”.

## Verified

- `pnpm run test:smoke scripts/test/release-ghcr-digest.test.ts`
- `pnpm run test:smoke scripts/test/push-release-ghcr-images.test.ts`
- `pnpm run test:smoke scripts/test/release-oci-attest-contract.test.ts`
- `pnpm run lint:code` (biome format on `scripts/lib/release-ghcr-digest.mts`)
