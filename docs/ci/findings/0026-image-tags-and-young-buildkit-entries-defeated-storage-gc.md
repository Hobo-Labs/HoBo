---
type: CI Performance Finding
title: "Finding 26: image tags and young BuildKit entries defeated storage GC"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 26: image tags and young BuildKit entries defeated storage GC

Two redeploy-time leaks kept filling the box. Each changed runner content key left another roughly **2 GB** `hobo-ci-worker:v*` image, including temporary registry/OCI artifacts, and `docker builder prune --filter until=24h --keep-storage 10GB` exempted every cache entry newer than a day. The cache could therefore grow **13 GB between prunes** despite the nominal bound.

All runner build and release entry points now reuse the content-keyed tag. Worker GC retains only the current and previous keys, always protecting `:local` and images used by running containers; the build helper registry is ephemeral and its layout/archive artifacts are deleted. The daemon applies the same worker selection on every scheduled GC and under pressure. BuildKit pruning now uses `HOBO_CI_WORKER_BUILDER_CACHE_CAP` (default **4 GB**, legacy keep-storage variable accepted as an alias) with no `until` filter on scheduled/pressure GC and at the end of runner and deps builds.
