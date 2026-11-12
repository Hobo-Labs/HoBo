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

- Before building, resolve an existing GHCR tag with `docker buildx imagetools inspect` (since [finding 143](0143-release-publish-needed-buildx-the-runners-lack.md), a direct registry `HEAD`: the runners have no buildx) (including buildx JSON `manifest.digest` and legacy `Digest` fields), then always verify labels via `docker pull` of the immutable `name@sha256:…` ref (never the mutable tag alone).
- Fail closed unless digest strings match `sha256:` + 64 lowercase hex, `io.hobo.release.image` matches the train image id, and `org.opencontainers.image.revision` (and version when present) matches `HOBO_RELEASE_REVISION` for this run.
- Write a normalized `ghcr.io/.../<image-id>@sha256:…` line either from reuse or after push, with registry fallback when local inspect is empty; full ref lines re-normalize through the expected GHCR name, and non–not-found imagetools failures fail closed (no silent overwrite).
- Treat only buildx `ERROR: <ref>: not found` when the parsed ref equals the requested tag (no prefix/digest-suffix collisions), plus manifest/name-unknown phrases that reference the exact tag; labels without digest, foreign `RepoDigests` hosts, and generic `not found` stderr fail closed.
- After push, resolve registry digest with the same 12×10s bounded retry budget as release OCI attest syft.
- Attest legs error on an empty digest artifact instead of treating it as “not in train”.

## Verified

- **TypeScript (Vitest):** `pnpm run test:smoke scripts/test/release-ghcr-digest.test.ts`, `push-release-ghcr-images.test.ts`
- **PACT / contract:** `pnpm run test:smoke scripts/test/release-oci-attest-contract.test.ts` (attest matrix + digest artifact handoff). **Gap:** GHCR `imagetools inspect` boundary is Vitest-mocked only — no executable consumer PACT against registry JSON/digest shape yet (follow-up).
- **Protobuf / CUE:** unchanged release image protobuf contracts; buildx imagetools JSON remains Vitest-mocked (tracked gap above), not protobuf/CUE-authored.
- `pnpm run lint:code` (biome format on `scripts/lib/release-ghcr-digest.mts`)
