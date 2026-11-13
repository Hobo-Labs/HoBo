---
type: Review Findings
title: "Ship-readiness gap review — deep audit for shipping HoBo"
description: "Deep gap review at 9d0233d2 (2026-07-30) against three ship targets (OSS public, local-first npm, hosted beta/GA). Supersedes 0002 on engineering maturity; remediation tracked in 0012."
tags: [hobo, plans, ship, gap-review]
---

# Ship-readiness gap review

> **Audited at:** `9d0233d2` (2026-07-30), branch `worktree/brave-river-7200`.  
> **Method:** Full recon of README / design / packages / CI; three parallel evidence passes (engineering, CI-security-tests, launch-legal-GTM); high-impact claims spot-vetted against source.  
> **Prior audit:** [`0002-public-launch-gap-analysis.md`](./0002-public-launch-gap-analysis.md) (2026-07-17) remains useful for launch-ops structure but is **stale on engineering scale**. This document supersedes it for current code maturity.  
> **Remediation:** `0012-ship-remediation-plan` (a plan, not kept in the repository) (work packages for agents).

## 1. Executive summary

**HoBo can ship a design-and-local-tool monorepo soon. It cannot ship the full multi-cloud hosted product yet.**

| Dimension | Verdict |
|---|---|
| Design suite | Strong; intent-alignment closed (`GAPS.md` all ✔) |
| Local product surface | Real (~169k LOC TS under `packages/`, 58 package manifests, composed CLI + MCP) |
| Hosted / multi-cloud product | Not shippable — default deploy is in-memory; live lanes credential-gated; federation/forge/ops incomplete |
| CI as release oracle | Broken — Actions jobs fail in ~3s with no runner assigned |
| Launch-ops / legal instances | Contracts exist; populated go/no-go and dashboard instances were missing at audit |

### Three ship targets (must distinguish)

| Target | Meaning | Readiness at audit |
|---|---|---|
| **A. OSS make-repo-public** | Source + design + site, pre-release | Near (weeks hygiene + decision) |
| **B. Local-first developer tooling** | npm/`npx` CLI + SDK, offline lane | Medium (publish + honesty + gates) |
| **C. Hosted public beta / GA** | Tenants, real cloud, support, legal | Far (quarters) |

## 2. What changed since 0002 (2026-07-17)

| 0002 claim | Reality at `9d0233d2` |
|---|---|
| ~18 packages, ~26–30k LOC | ~58 package manifests, ~169k production TS lines |
| No iac / identity / mcp / cloud | Present: `iac-*`, `identity`, `mcp`, `cloud`, `broker`, `stations`, `connectivity`, `trails`, `replay`, multi-provider tree |
| No real cloud path | Credential-gated CF/Vercel + `HOBO_PULUMI_LIVE=1`; **default still in-memory** |
| 1 hardened proof / 647 grandfathered | ~655 `proof.json`, **619 grandfathered** (advisory artifacts) |
| 2 feature files | 28 `.feature` files |
| High overclaim risk on site | Site trail map honest (`site/src/pages/guide/status.md`) |

Design-intent register [`GAPS.md`](../../GAPS.md): closed (40 findings, all ✔). That is design alignment, not product ship.

## 3. What runs today

### Without credentials

- `bindle()` → `hobo collect` / `plan` / `up` / `down` / `dev` on local **in-memory IaC + SQLite EventStore**
- Gatekeeper, EffectSpec / ResilienceProfile, can-deploy
- Stations + Broker (local), Trails, continuous identity (local/fixture)
- `hobo-mcp` stdio, deny-default auth, CLI verb parity
- Examples: `hello-bindle`, `multi-cloud-shop`, `durable-agent`, `self-host-yard`
- Session Replay on App Kits (ADR-0137) in the local lane

### Credential- or engine-gated

- `HOBO_PULUMI_LIVE=1` — real Pulumi Automation/CLI
- `VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN` + account — live deploy lanes
- Live Terraform/OpenTofu / kubectl paths
- Real OIDC / SPIRE / production STS — **not** default (fixture login HONEST SCOPE)

### Incomplete / stubbed (evidence)

| Surface | Evidence | Implication |
|---|---|---|
| Default IaC | `packages/hobo/src/compose.ts` HONEST SCOPE | `up` can succeed without real infra |
| CF/Vercel live | Deploy provider HONEST SCOPE + fixture trees | HTTP client smoke, not full Bindle→provider |
| Cloud providers | `realize()` emits programs, does not apply | Portability is IR-level |
| `@hobo/componentize` | `buildWasmContractBytes` (wasm magic + custom section) | Contract-shaped wasm, not jco |
| `runtime-cloud-native` | `HOBO_CLOUD_NATIVE_UNIMPLEMENTED` | Mock-only |
| Login / claim step-up | Fixture login; WebAuthn not enforced | Not production auth |
| Registry / Forge | No `@hobo/registry` | S5 not product |
| npm | `@hobo/*` not on registry; `0.0.1`; no publish workflow | No external install |

Canonical CLI verbs: **38** (`packages/cli/src/shell/verbs.ts`). Site often says 28; README said 27 packages/27 verbs at audit — drift.

## 4. Stage maturity

| Stage | Intent | Approx maturity | Gate evidence at audit |
|---|---|---|---|
| S0 | Signed hello through CI | ~60–75% | S0 table all `TODO`; CI runners dead |
| S1 | Offline + replay==live | ~75–90% | Local pass noted; CI pending runners |
| S2 | First real cloud | ~40–60% | Code present; default offline |
| S3 | Agent MCP keyless | ~35–50% | MCP+identity models; fixture auth |
| S4–S6 | Multi-cloud / forge / ops | Foundations | Far |

## 5. Readiness scorecard (fail-closed)

| Field | Status | Why |
|---|---|---|
| Cutline | 🔴 | No accepted cutline instance; requirements unratified |
| Blockers | 🔴 | No live blocker register; CI red unrecorded |
| Milestone health | 🔴 | No dashboard instance |
| Evidence links | 🔴 | S0 CI cells `TODO` |
| Accepted risks | ⚪→🔴 | Known risks unaccepted on record |
| Owners | 🔴 | Roles unbound; bus-factor unrecorded |
| Last verified | 🔴 | Last successful scheduled `HoBo CI Fabric` on `main`: **2026-06-29** |

## 6. Findings index

IDs are stable for remediation tracking in 0012.

### Decision / launch-ops

| ID | Finding | Class | Effort |
|---|---|---|---|
| L0 | Ship targets A/B/C conflated; no launch-definition decision | Launch blocker (decision) | S |
| O1 | No populated go/no-go or readiness dashboard instances | Blocker for “ready” claims | S |
| O2 | Customer ToS / privacy / DPA / subprocessor list absent | **Blocker C only** | L counsel |
| O3 | Support = design-repo path only | Blocker C beta | M ops |
| O4 | Dogfood Yard / Beta Pilot open | Blocker C | L |
| O5 | OSS hygiene largely done | Strength for A | residual S |
| O6 | Requirements suite unratified | Blocker C GA | M |
| O7 | GAPS.md design-closed ≠ product-shipped | Informational | — |
| O8 | Single-maintainer bus factor unrecorded | High-risk non-blocker | S |

### Validation / CI

| ID | Finding | Class | Effort |
|---|---|---|---|
| V1 | Actions never assigns runners (~3s, `runner: None`) | Blocker for CI-proven ship | S (account) |
| V2 | S0 acceptance CI columns all `TODO` | Blocker for S0-done claim | S after V1 |
| V3 | `main-gate` does not run on `push` to `main` | High-risk non-blocker | S |
| V4 | S0 digest-parity hardcodes `ubuntu-latest` artifact path | Latent CI bug | S |

### Engineering

| ID | Finding | Class | Effort |
|---|---|---|---|
| E1 | Nothing published to npm | Blocker B | M |
| E2 | Default deploy in-memory Pulumi | Blocker C claims / note B | by design |
| E3 | Synthetic componentize wasm | Blocker portable-WASM story | L real / S honesty |
| E4 | Live CF/Vercel fixture smokes | High-risk non-blocker | L fix / S label |
| E5 | Providers realize, don’t apply | Blocker multi-cloud C | L |
| E6 | Fixture login, no production OIDC default | Blocker S3 claims | L |
| E7 | runtime-cloud-native stubs | Launch note | L or docs S |
| E8 | No registry/forge package | Post-GA S5 | L |
| E9 | README package/verb count drift | Launch note | S |
| E10 | Dual `hobo` bin (`@hobo/cli` + `@hobo/hobo`) | Publish risk | S–M |
| E11 | Many packages `publishConfig.public` at 0.0.1 immature | Pre-publish risk | S |

### Tests / proofs

| ID | Finding | Class | Effort |
|---|---|---|---|
| T1 | 619 grandfathered proofs advisory-only | High-risk non-blocker | L waves |
| T2 | Manifests ≠ fully executed artifacts | Launch note A/B | L |
| T3 | Behavior lane improved (28 features) | Positive | — |

## 7. Target must-lists (audit baseline)

### A — OSS public

Must: launch definition; truth-in-advertising; history secret scan; working SECURITY contact.  
Should: restore Actions; fill S0/S1 tables.  
Not required: customer ToS, dogfood, npm, multi-cloud.

### B — Local-first npm

Must: A + publish allowlist + prerelease tags + single install story + offline golden path + HONEST SCOPE in package docs + support boundary + known-limitations in release notes.  
Should: CI restored; componentize honesty or real jco; Dependabot/CodeQL.  
Not required: hosted ToS, Firecracker, forge, dual-cloud live.

### C — Hosted beta/GA

Must: public-beta cutline; dashboard + go/no-go instances; counsel terms/privacy; subprocessor list; staffed support; dogfood on real provider; one non-fixture Bindle→cloud path; security claims evidence.  
GA additionally: DR evidence if claimed; paid stack if charging; ratified cutline.

## 8. Risk register (top)

1. Marketing full meta-cloud while default is in-memory  
2. Permanently red CI → silent quality erosion  
3. Synthetic wasm sold as portable membrane  
4. Accidental publish of immature packages  
5. Hosted beta without ToS/privacy  
6. Single maintainer holds all roles  
7. Fixture login mistaken for SSO  
8. 619 advisory proofs overstate design evidence  
9. Competitive decay on multi-cloud claims  
10. Unratified requirements → no signed release criteria  

## 9. Not fully audited

- Full local `check:all` on this machine  
- `pnpm audit` CVE inventory  
- Live Linear issue states  
- Every provider live path E2E  
- Full git-history secret scan (required before Target A)

## 10. Supersession

- Engineering maturity claims in **0002 §4.1** are superseded by this document.  
- Launch-ops “contracts without instances” finding from **0002** remains valid until 0012 remediations land.  
- Intent gaps: still owned by root [`GAPS.md`](../../GAPS.md) (closed).
