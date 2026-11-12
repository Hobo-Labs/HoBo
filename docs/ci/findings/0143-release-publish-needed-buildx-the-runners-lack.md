---
type: CI Performance Finding
title: "Finding 143: release publish needed buildx the runners lack"
description: "The GHCR reuse check called docker buildx imagetools inspect; the release runners have no buildx plugin, so every publish leg failed closed before building."
tags: [hobo, ci, release, ghcr, buildx, registry]
---

# Finding 143: release publish needed buildx the runners lack

## Evidence

Release run [43243795828](https://github.com/Hobo-Labs/HoBo/actions/runs/43243795828) was the first to include the GHCR reuse check from [finding 138](0138-release-attest-missing-digest-after-cancel.md). All six publish legs failed within seconds of starting the publish step, before building anything:

```text
Error: imagetools inspect ghcr.io/hobo-labs/hobo/hobo-sdk:v0.0.0-alpha.168 failed (status 125): Run 'docker COMMAND --help' for more information on a command.
    at imagetoolsInspectTag (scripts/lib/release-ghcr-digest.mts)
    at tryReusePublishedTag (scripts/ci/push-release-ghcr-images.mts)
```

Exit status 125 with that text is the Docker CLI rejecting an unknown subcommand: the runners have no buildx plugin. `publish-deps.sh` already checks `docker buildx version` and skips its buildx step when it is missing. With the publish legs failing, no signed tag and no GitHub Release came out of the run.

## Cause

`tryReusePublishedTag` asks the registry whether the release tag already exists before building, and if it does, for its digest. It asked through `docker buildx imagetools inspect`, and any failure other than a recognised "not found" fails closed, so a missing plugin failed every leg.

## Fix

`registryInspectTag` asks the registry directly: one `HEAD /v2/<name>/manifests/<tag>` with the index and manifest media types accepted. It returns the `Docker-Content-Digest` header, or nothing on 404. Any other answer (401, 5xx, no digest, a digest of the wrong shape, a timeout) still fails closed.

- **Token:** it fetches a pull token from the registry's token endpoint, using `GITHUB_TOKEN` (now set on the publish step) or the `ghcr.io` login `docker login` already wrote. Credentials go only to that endpoint and are never printed.
- **Process:** it runs in a child `node` with a 60-second limit, so the release scripts stay synchronous.
- **Callers:** the reuse check and the post-push digest fallback both use it. `imagetoolsInspectTag` stays for its tests, but no release path calls it.

Labels are still verified by pulling the image by digest, as before.

## Verified

- Against GHCR: `ghcr.io/actions/actions-runner:latest` returned its `sha256:` digest, and a missing tag returned absent.
- `scripts/test/release-ghcr-digest.test.ts` covers:
  - the host, repository and tag sent;
  - 404 as absent;
  - failing closed on 401, a missing or malformed digest, and a child that exits non-zero;
  - that neither the publish script nor the default resolvers use buildx.
