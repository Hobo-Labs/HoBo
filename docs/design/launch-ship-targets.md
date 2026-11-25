---
type: Reference
title: "Launch ship targets (A / B / C)"
description: "Human-facing summary of ADR-0140: OSS public, local-first developer tooling, and hosted beta/GA ship targets with interim S-stage cutlines."
tags: [hobo, design, ship, launch]
---

# Launch ship targets

> **Decision:** [ADR-0140](./adr/07-portability-extensibility.md#adr-0140)  
> **Instances:** [`instances/`](./instances/README.md)

HoBo has **three different “ship” meanings**. Public claims must name which one.

## Targets

| Target | Name | What ships | Interim cutline (S-stage) |
|---|---|---|---|
| **A** | OSS public | Source, design suite, site — **pre-release** monorepo | **S0/S1 hygiene:** truth-in-advertising, secret scan, SECURITY contact. CI green preferred, not hard-gated for “repo public”. |
| **B** | Local-first developer tooling | npm/`npx` CLI + SDK for **offline/local** lane | **S1 offline golden path** + publish allowlist/prerelease + HONEST SCOPE. **S2 live cloud not required**. |
| **C** | Hosted beta / GA | Tenants, real cloud apply, support, legal | **S2+** (beta) with legal + dogfood + real apply; **S3+/M3–M4** for GA claims. |

Default order: **A → B → C**.

## Claim rules

1. Name the target in README, site status, release notes, and marketing.
2. Do not use Target A or B evidence to imply Target C readiness.
3. Hosted **C** stays blocked until counsel legal text, dogfood on a real provider, and at least one non-fixture apply path land.
4. Do not claim CI is green without a real runner log. Do not invent secrets or counsel-approved legal copy.

## Go / no-go gates

| Gate value | Target | Contract |
|---|---|---|
| `repo-public` | A | [go-no-go-decision-record.md](./go-no-go-decision-record.md) |
| `developer-tooling` | B | same |
| `beta` / `release-candidate` / `GA` | C | same (productization M3/M4) |

## Must-lists (audit baseline from 0011)

### A — OSS public

**Must:** launch definition (this doc + ADR-0140); truth-in-advertising; history secret scan; working SECURITY contact.  
**Should:** restore Actions; fill S0/S1 acceptance tables.  
**Not required:** customer ToS, dogfood, npm publish, multi-cloud apply.

### B — Local-first npm

**Must:** A + publish allowlist + prerelease tags + single install story + offline golden path + HONEST SCOPE in package docs + support boundary + known limitations in release notes.  
**Should:** CI restored; componentize honesty or real jco; Dependabot/CodeQL.  
**Not required:** hosted ToS, Firecracker, forge, dual-cloud live.

### C — Hosted beta/GA

**Must:** public-beta cutline; dashboard + go/no-go instances; counsel terms/privacy; subprocessor list; staffed support; dogfood on real provider; one non-fixture Bindle→cloud path; security claims evidence.  
**GA additionally:** DR evidence if claimed; paid stack if charging; ratified cutline.

## Related

- Readiness dashboard contract: [`v1-readiness-dashboard.md`](./v1-readiness-dashboard.md)
- First populated instances (2026-07-30): [`instances/`](./instances/README.md)
