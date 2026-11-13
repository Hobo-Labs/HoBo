---
type: Reference
title: "Go/no-go — developer-tooling (Target B) — 2026-07-30"
description: "Conditional-go for Target B prep only (allowlist, private flags, honesty, dual-bin). Live npm publish remains no-go until H-E1b (+ preferred green CI). Target A secret scan Met 2026-07-30."
tags: [hobo, design, ship, instances, go-no-go]
---

# Go/no-go decision — `developer-tooling` — 2026-07-30

> **Contract:** [`go-no-go-decision-record.md`](../go-no-go-decision-record.md)  
> **Ship target:** **B — local-first developer tooling** ([ADR-0140](../adr/07-portability-extensibility.md#adr-0140), [`launch-ship-targets.md`](../launch-ship-targets.md))  
> **Depends on:** Target A posture ([`go-no-go-repo-public-2026-07-30.md`](./go-no-go-repo-public-2026-07-30.md))  

## Decision record

| Field | Value |
|---|---|
| **Gate** | `developer-tooling` |
| **Decision** | **conditional-go** for **prep only** (docs + allowlist + dry-run workflow). **no-go** for live registry publish until H-E1b + preferred green CI |
| **Approver role** | Release owner (single maintainer: **Tyler Kendrick**) |
| **Evidence links** | WP-B honesty; WP-D allowlist + private flags + publish.yml dry-run; [`npm-publish-allowlist.md`](../npm-publish-allowlist.md); residual [`residual-human-blockers-2026-07-30.md`](./residual-human-blockers-2026-07-30.md); Target A secret scan Met ([go-no-go-repo-public](./go-no-go-repo-public-2026-07-30.md) condition 3); **no** live `npm publish` claimed |
| **Blocker deltas** | **Resolved by agents:** dual-bin (cli `bin` removed); allowlist + immature `private: true`; honesty on in-memory default + synthetic componentize; Target A history secret scan **Met**. **Still open for live B:** live publish (H-E1b), Actions runners (H-V1 preferred before publish). |
| **Accepted risks** | Same register [`accepted-risks-2026-07-30.md`](./accepted-risks-2026-07-30.md). For B, synthetic wasm and in-memory default are **must-label** limitations, not silent defaults. |
| **Expiry / revisit** | **2026-09-15** or first live allowlisted publish attempt, whichever first |

## Why live publish is still no-go

| Must-list item (Target B) | Status after WP-B/D + secret scan |
|---|---|
| Target A must-list (conditional-go path) | **Conditional-go Met path** — history **secret scan Met (2026-07-30)**; A still conditional on human visibility flip + H-V1 residual ([go-no-go-repo-public](./go-no-go-repo-public-2026-07-30.md)) |
| Publish allowlist + prerelease policy | **Met** (docs); version tags not bumped yet |
| Single install story (`@hobo/hobo` vs `@hobo/cli`) | **Met** — product bins on `@hobo/hobo` only |
| Offline golden path + HONEST SCOPE in package docs | **Met** for honesty labeling (WP-B) |
| Support boundary for CLI-only | **Documented** as pre-release; not staffed SLA |
| Known limitations projected | **Met** in known-limitations register |
| npm registry publish | **Not done** (human H-E1b; dry-run workflow only) |
| CI green preferred | **Open** H-V1 |

## Path to live-publish go (later instance)

When all of the following are true, file a **new dated** go/no-go instance (do not silently rewrite this one as live-go):

1. Target A conditional-go still valid (re-run secret scan before public flip if shipping public install).  
2. Publish allowlist + `private: true` on immature packages (already Met).  
3. One product `hobo` bin story (already Met).  
4. HONEST SCOPE still accurate in package docs.  
5. Prerelease version/tag applied for the release cut.  
6. Human runs first allowlisted publish with `NPM_TOKEN` (H-E1b); agents do not claim publish success without registry evidence.  
7. Prefer H-V1 restored so CI can prove the release path.

## What this decision is not

- Not authorization to `npm publish` today.
- Not hosted multi-cloud readiness.
- Not a claim that jco/componentize-js is production-real.
- Not a claim that Target A secret scan is still open (it is **Met** as of 2026-07-30).

## Outcome summary

**Prep conditional-go for Target B** as of 2026-07-30 (allowlist, private flags, dual-bin, honesty). **Live registry publish remains no-go** until H-E1b (+ preferred green CI). External install claims (`npx`, public `@hobo/*` on npm) remain invalid until a later live-publish go/conditional-go instance.
