---
type: CI Performance Finding
title: "Finding 118: main shard checkout promisor flake"
description: "Main workspace test shard failed in actions/checkout with promisor/HTTP2 transport errors before tests ran."
tags: [hobo, ci, checkout, git-mirror, shards, flake]
---

# Finding 118: main shard checkout promisor flake

## Evidence

Main Fabric run [43139135072](https://github.com/Hobo-Labs/HoBo/actions/runs/43139135072) on `fd0bc91ae` (**2025-11-12**): **Main workspace test shard 3** failed in **~7s** during `actions/checkout` (job `130923061221`, box runner `hobo-df7e26a6`) before any tests. Log signatures: `could not fetch … from promisor remote`, `curl 92` / `HTTP/2 … PROTOCOL_ERROR`, `expected 'packfile'`, and missing `scripts/ci/ci-trace.mts`.

## Cause

Trunk workspace shards used a bare `actions/checkout` with `clean: false` after a **blob:none** bootstrap, so promisor fetches still hit GitHub under load. **Main full gate** already used `hobo-checkout` (mirror probe, HTTP/1.1, triple retry); shards did not.

## Fix

- New composite **`hobo-repo-checkout`**: box mirror probe (`GIT_CONFIG_SYSTEM` + `HOBO_CI_GIT_MIRROR_RESOLVED`), **alternates** seeding via `repo-checkout.mts`, then up to **three** pinned remote checkouts with **8s backoff**.
- Wired into **main workspace test shards**, **PR workspace shards**, **PR affected lanes**, and **main full gate (finish)** checkout.
- `scripts/actions:lint` accepts `hobo-repo-checkout` as a checkout source for repo-local composites.
- Workflow jobs prepend pinned sparse `actions/checkout` for `.github/actions` so GitHub-hosted fallbacks can load `hobo-repo-checkout`; the composite runs with `bootstrap-composite-actions: false` after that.

## Measure

After redeploy, promisor/HTTP2 flakes on box trunk/PR checkouts recover without manual rerun; checkout failures log `hobo_ci_repo_checkout=fail` with transport classification when mirror path fails; markers (`scripts/ci/ci-trace.mts`, `scripts/ci/gitleaks-main-scan.mts`) fail closed when blobs are still missing.
