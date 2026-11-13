---
type: Reference
title: "Residual Human Blockers Ledger (2026-07-30)"
description: "Populated instance of ship-remediation residual H-* items from plan 0012. Agents cannot close these; each row records why, the unblock condition, and owner role. Not a claim that any blocker is fixed."
tags: [hobo, design, instances, ship, residual, human-blockers]
---

# Residual Human Blockers Ledger (2026-07-30)

> **Status:** open ledger. **Agents must not mark these fixed.**  
> **Parent plan:** `0012-ship-remediation-plan` (a plan, not kept in the repository)  
> **Findings:** [`docs/plans/0011-ship-readiness-gap-review.md`](../../plans/0011-ship-readiness-gap-review.md)  
> **Ship targets:** Target A (OSS public hygiene) → B (local-first npm) → C (hosted beta/GA). Most rows block B and/or C, not repo-public hygiene alone.

This instance is the durable residual ledger for work that **requires a human, account, counsel, or multi-day product program**. Agent work packages (WP-A–E) implement max docs/config/code honesty; they do **not** restore Actions runners, publish to npm, draft counsel-approved legal text, or ship real multi-cloud apply.

## Field legend

| Field | Meaning |
|---|---|
| ID | Stable residual id from plan 0012 |
| Title | Short name |
| Why agent cannot close | Hard dependency on account, credentials, counsel, staffed ops, or deferred product scope |
| Unblock condition | Concrete human/product action that would close or downgrade the item |
| Owner role | Accountable role (not an agent) |
| Ship target impact | Which launch target stays blocked or conditional |

## Ledger

### H-V1 — Actions runners

| Field | Value |
|---|---|
| **ID** | H-V1 |
| **Title** | Restore GitHub Actions runner assignment |
| **Why agent cannot close** | Jobs fail closed with no runner assigned (`runner: None` ~3s). Root cause is account billing / spending limit / runner policy on the GitHub org — not workflow YAML. Agents must not invent green CI URLs. |
| **Unblock condition** | Org owner restores runner assignment (billing/spending limit, hosted runners, or self-hosted labels that match workflow vars). At least one successful `main` / stage-gate run with logs proves CI as oracle again. |
| **Owner role** | GitHub org / account owner (billing) |
| **Ship target impact** | Blocks CI-proven claims for A (if “CI green” is required), B (publish gates), and all stage-gate “done” claims |

### H-O2 — Legal counsel

| Field | Value |
|---|---|
| **ID** | H-O2 |
| **Title** | Counsel-approved ToS, privacy, DPA, subprocessor list |
| **Why agent cannot close** | Customer legal text requires licensed counsel. Agents may only write process contracts, checklists, and placeholders — not counsel-approved customer terms. |
| **Unblock condition** | External or in-house counsel delivers reviewable ToS, privacy notice, DPA, and subprocessor list; release owner records acceptance against [legal-privacy-terms-readiness](../legal-privacy-terms-readiness.md). |
| **Owner role** | Legal / privacy owner (+ counsel) |
| **Ship target impact** | **Blocker for Target C** (hosted beta/GA). Not required for pure OSS repo-public Target A if no customer SaaS claims. |

### H-O3 — Staffed support

| Field | Value |
|---|---|
| **ID** | H-O3 |
| **Title** | Staffed support for hosted beta |
| **Why agent cannot close** | Support today is design-repo / issue path only. Hosted beta needs human coverage, escalation path, and response expectations — not more markdown alone. |
| **Unblock condition** | Named support owner, channels, and staffing for pilot cohort; SLA/escalation instances populated per [support-sla-channels](../support-sla-channels.md) and [launch-support-escalation](../launch-support-escalation.md). |
| **Owner role** | Support owner / ops lead |
| **Ship target impact** | **Blocker for Target C** private beta |

### H-O4 — Dogfood / pilot

| Field | Value |
|---|---|
| **ID** | H-O4 |
| **Title** | Dogfood Yard on real cloud + beta pilot |
| **Why agent cannot close** | Requires operator time on real cloud accounts, pilot customers, and operational evidence. Agents cannot substitute private dogfood runs or invent pilot feedback. |
| **Unblock condition** | Dogfood Yard exercised on real cloud with recorded evidence; beta pilot cohort and feedback loop accepted per [dogfood-yard](../dogfood-yard.md) and [beta-pilot-feedback](../beta-pilot-feedback.md). |
| **Owner role** | Product / release owner (Dogfood Yard & Beta Pilot) |
| **Ship target impact** | **Blocker for Target C**; strengthens B only as optional confidence |

### H-E1b — npm publish token

| Field | Value |
|---|---|
| **ID** | H-E1b |
| **Title** | First real npm publish (`NPM_TOKEN` + green CI) |
| **Why agent cannot close** | Needs registry credentials, trusted publish path, and CI that can sign/attest. Agents may prep allowlists, `private` flags, and manual publish workflows — not live `npm publish` or secret values. |
| **Unblock condition** | (1) H-V1 restored so gates can go green; (2) org secrets / OIDC for npm configured outside the repo; (3) human runs first publish of allowlisted packages at agreed prerelease version. |
| **Owner role** | Release owner (+ npm org admin) |
| **Ship target impact** | **Blocker for Target B** (external install). Prep work is agent-safe; publish is human. |

### H-E3b — Real jco / componentize-js

| Field | Value |
|---|---|
| **ID** | H-E3b |
| **Title** | Real jco/componentize-js production pipeline |
| **Why agent cannot close** | Multi-day engineering. Today `@hobo/componentize` uses `buildWasmContractBytes` (wasm magic + custom section) — **contract-shaped**, not production Component Model output. Honesty docs/source comments are the agent max for WP-E. |
| **Unblock condition** | Pinned jco / componentize-js / wasm-tools pipeline produces real components; determinism + stage-gate digests re-baselined; package docs drop synthetic-only disclaimer. |
| **Owner role** | Platform / WASM runtime engineer |
| **Ship target impact** | Blocks portable-WASM production story; S0 digest/sign evidence remains contract-bytes until this lands. Target A/B may ship with explicit honesty. |

### H-E5 — Live multi-cloud apply

| Field | Value |
|---|---|
| **ID** | H-E5 |
| **Title** | Live AWS / GCP / Azure apply paths |
| **Why agent cannot close** | Providers currently **realize** programs; apply is credential-gated or absent. Live multi-cloud needs real accounts, policy, and product work — not fixture smokes alone. |
| **Unblock condition** | Documented live apply lanes for at least the cutline providers with fail-closed credentials, evidence in stage acceptance, and no default in-memory success presented as multi-cloud production. |
| **Owner role** | Cloud platform / control-plane owner |
| **Ship target impact** | **Blocker for Target C** multi-cloud claims (S4+) |

### H-E6 — Production OIDC

| Field | Value |
|---|---|
| **ID** | H-E6 |
| **Title** | Production OIDC / SPIRE (not fixture login) |
| **Why agent cannot close** | Default identity path remains fixture / HONEST SCOPE local. Production federation needs IdP/SPIRE ops and security sign-off. |
| **Unblock condition** | Production OIDC (and SPIRE if claimed) default path documented and proven offline-fail-closed; fixture login labeled non-production only. Security owner accepts for S3 agent-autonomy claims. |
| **Owner role** | Identity / security owner |
| **Ship target impact** | **Blocker for S3 / Target C** production auth claims |

### H-T1 — Proof-hardening waves

| Field | Value |
|---|---|
| **ID** | H-T1 |
| **Title** | Full proof-hardening waves W3–W6 (artifact allowlist cleared 2026-07-31) |
| **Why agent cannot close** | ~~Hundreds grandfathered~~ **Artifact allowlist is empty (618 bulk-hardened 2026-07-31).** Remaining quality depth (richer examples, real benches, UX wireframe fidelity) is ongoing product work, not the advisory gate. |
| **Unblock condition** | ~~Allowlist empty as of 2026-07-31~~ (done via `scripts/bulk-harden-proofs.mts`). Optional follow-up: replace identity scaffolds with package-specific rich examples/benches/UX fidelity where product value warrants. |
| **Owner role** | Engineering program / proof hardening owner |
| **Ship target impact** | High-risk non-blocker for A/B if honesty holds; residual risk for “proof complete” claims |

## Summary matrix

| ID | Title | State | Owner role | Agents may |
|---|---|---|---|---|
| H-V1 | Actions runners | **human open** | Org/account owner | Document pending runners; fix workflow bugs only |
| H-O2 | Legal counsel | **human open** | Legal/privacy + counsel | Process checklists; never final customer legal |
| H-O3 | Staffed support | **human open** | Support/ops | Design routes; not staffing |
| H-O4 | Dogfood / pilot | **human open** | Product/release | Acceptance contracts; not live dogfood |
| H-E1b | npm publish token | **human after CI** | Release + npm admin | Allowlist, private flags, manual workflow skeleton |
| H-E3b | Real jco | **deferred L** | Platform/WASM | Honesty labels + contract-bytes path |
| H-E5 | Live multi-cloud apply | **deferred** | Cloud platform | IR/realize honesty; no fake apply green |
| H-E6 | Production OIDC | **deferred** | Identity/security | Fixture honesty; no production IdP |
| H-T1 | Proof waves W3–W6 | **artifact gate cleared** (depth optional) | Eng program | Optional richer fixtures; no grandfather allowlist |

## Explicit non-claims

- This ledger does **not** claim H-V1 fixed or CI green.
- This ledger does **not** authorize npm publish, customer ToS, or hosted beta.
- Closing a row requires the **owner role** to record evidence elsewhere (go/no-go instance, readiness dashboard, or counsel acceptance) — not an agent checkbox.

## Related records

- [Launch blocker taxonomy](../launch-blocker-taxonomy.md)
- [V1 readiness dashboard contract](../v1-readiness-dashboard.md)
- [Go/no-go decision record](../go-no-go-decision-record.md)
- [Known limitations register](../known-limitations-register.md)
- [Security policy](../../../SECURITY.md) (public vulnerability reporting path)
