---
type: CI Performance Finding
title: "Finding 94: deps publisher docker headroom"
description: "Publisher build-deps refused when bind mounts did not match DockerRootDir device; CI deps layer needed learned memory above 4096 MiB."
tags: [hobo, ci, deps-layer, docker, publisher]
---

# Finding 94: deps publisher docker headroom

## Evidence

CI deps image publisher run [42977459279](https://github.com/Hobo-Labs/HoBo/actions/runs/42977459279) (job `130379764806`) failed on **Publish missing deps tag with a bounded wall clock** after GHCR worker pull missed and local `build-deps.sh` preflight passed:

```text
cannot sample Docker data root for deps build headroom
```

**CI deps layer (pnpm)** on main peaked at **4097 MiB** against a **4096 MiB** container limit.

## Cause

Inside an isolated publisher container, `docker info` reports the host `DockerRootDir` but that path is not mounted. Headroom sampling only accepted bind mounts on the same block device as the data root; when device resolution failed or no mount matched, the script exited before admission instead of falling back to host-visible `df` or `docker run … df /host${DockerRootDir}`.

Deps-layer jobs reused the heavy unmeasured reservation (**4096 MiB**) until three peaks existed, so a single **4097 MiB** peak could brush the limit.

## Fix

1. `build-deps.sh` — device-matched candidates first, then any sampleable bind mount, then host `DockerRootDir` via `sample_docker_headroom_via_host`; `host:` prefix paths for repeated samples.
2. `deps-docker-headroom.ts` + tests — document the resolution order for regression.
3. `memory-classes.ts` — `CI deps layer (pnpm)` uses `CI_DEPS_LAYER_MEMORY_LEARNED_MIN_MB` (**4352**) before learned peaks apply.

## Proof

- `packages/ci-gh-actions/test/deps-docker-headroom.test.ts`
- `packages/ci-gh-actions/test/memory-classes.test.ts`
- `scripts/test/ci-deps-image-contract.test.ts`
