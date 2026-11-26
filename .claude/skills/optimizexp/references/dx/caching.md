---
type: Agent Skill Reference
title: "OptimizeXP DX — artifact caching"
description: "Local and remote caches for builds, tests, and codegen artifacts."
tags: [hobo, optimizexp, dx, cache]
timestamp: 2026-07-30T00:00:00Z
---

# DX — artifact caching

## What to cache

| Artifact | Risk if stale |
|---|---|
| Build outputs | Medium — rebuild wrong graph |
| Test results | High if trust without invalidation |
| Codegen | High — drift gates must exist |
| Search indexes (`tgrep`) | Low — rebuild on miss |
| Package manager store | Low |

## Principles

1. Cache keys include inputs that change semantics (lockfile, schema digests).
2. Prefer **content-addressed** artifacts when sharing across machines.
3. Agents must know how to **bust** a bad cache (`--force`, clean targets).
4. Never cache secrets.

## HoBo notes

- Turbo task caching when configured
- Generated protobuf/WIT outputs checked in with drift gates
- `promotions:check` digests for frozen proofs
- pnpm store / frozen lockfile installs

## Friction smells

- Full reinstall to fix transient failures
- No documented clean command
- CI cache restores wrong Node version outputs
