---
type: CI Performance Finding
title: "Finding 97: ci runner image ghcr materialize"
description: "Main Fabric paid full OCI rebuild before deps layer; materialize-only GHCR pull and parallel deps routing shorten the critical path."
tags: [hobo, ci, runner-image, ghcr, deps-layer]
---

# Finding 97: ci runner image ghcr materialize

**Status:** mitigated  
**First seen:** Main Fabric 42987900597 (`4fd81a0f8`) — `CI runner image (mise oci)` ~3m33s on critical path before deps layer.

## Symptom

Main runs wait on `ci-deps-image` behind a full runner OCI rebuild even when the content-keyed worker image already exists in GHCR or on the host. The Fabric job also paid `pnpm install` and shell lint before `build.sh`, which already prefers GHCR pull.

## Change

- `ensure-ci-worker-image.mts --materialize-only`: host tag hit or GHCR manifest pull only; exit 2 when native build is required.
- `ci-runner-image` job runs materialize before preflight/pnpm/native build; native chain runs only when materialize fails.
- `ci-deps-image` needs `route` only so deps layer work overlaps runner image materialize on main.

## Proof

- `scripts/test/ci-deps-image-contract.test.ts`
- `scripts/test/push-ci-runner-image-ghcr.test.ts`
- `scripts/ci/ensure-ci-worker-image.mts`
