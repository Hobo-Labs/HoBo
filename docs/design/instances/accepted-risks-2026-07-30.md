---
type: Reference
title: "Accepted risks register instance — 2026-07-30"
description: "Dated accepted-risk rows for ship review: single maintainer, CI outage, synthetic wasm, in-memory default IaC. Not a waiver of launch blockers for Target C."
tags: [hobo, design, ship, instances, risks]
---

# Accepted risks — 2026-07-30

> **Taxonomy:** [`launch-blocker-taxonomy.md`](../launch-blocker-taxonomy.md)  
> **Process:** [`go-no-go-decision-record.md`](../go-no-go-decision-record.md) risk acceptance rules  
> **Ship targets:** [ADR-0140](../adr/07-portability-extensibility.md#adr-0140)  
> **Owner of this register:** single maintainer (**Tyler Kendrick**)  
> **Scope:** risks accepted for **interim Target A / prep toward B** decision-making. **Not** a waiver of Target C launch blockers (legal, dogfood, real apply).

## Risk rows

| ID | Risk | Class | Applies to | Owner | Mitigation | Launch note / follow-up | Revisit |
|---|---|---|---|---|---|---|---|
| AR-2026-07-30-01 | **Single maintainer bus factor** — release, security, legal liaison, and support roles unbound; all held by Tyler Kendrick | High-risk non-blocker (A/B); **blocker for staffed C beta** if unmitigated | A, B (accept); C (do not accept as sufficient for public beta) | Tyler Kendrick | Document all roles on instances; fail closed on multi-party gates; no solo “legal approved” customer terms | Recruit/delegate owners before Target C beta; O8 in 0011 | **2026-09-30** |
| AR-2026-07-30-02 | **CI runner outage** — GitHub Actions jobs fail in ~3s with no runner assigned; last successful scheduled main fabric noted 2026-06-29 in audit; **CI not claimed green** | High-risk non-blocker for A under ADR-0140; high-risk for B; process blocker for CI-proven claims | A (accepted residual); B (prefer restore before publish); all CI-proven ship claims | Tyler Kendrick (human H-V1 for billing/spending limit) | Local gates + honesty that CI is not oracle; restore runners; fix workflow path bugs (WP-C) without inventing green logs | Do not market “CI green”; restore Actions before treating main as release oracle | **2026-08-30** |
| AR-2026-07-30-03 | **Synthetic componentize wasm** — `@hobo/componentize` builds contract-shaped wasm (`buildWasmContractBytes`), not full jco/componentize-js portable membrane | Launch note (A/B honesty); launch blocker if sold as real portable WASM | A, B (label required); portable-WASM product claims | Tyler Kendrick | HONEST SCOPE / known-limitations wording (WP-B/E); optional later real jco (H-E3b, multi-day) | Customer-visible: synthetic/reference unless real pipeline lands | **2026-10-31** or first real jco PR |
| AR-2026-07-30-04 | **In-memory default IaC** — default deploy path can succeed without real cloud infra (`packages/hobo` compose HONEST SCOPE); live lanes credential-gated | Launch note (A/B); **launch blocker** for hosted multi-cloud product claims | A, B (label required); C claims blocked until real apply | Tyler Kendrick | Document offline/in-memory default; never imply multi-cloud GA from local `up`; real apply is H-E5 / Target C must | Messaging: local-first / offline default; cloud apply explicit and gated | **2026-09-30** |

## Explicit non-acceptances

These remain **launch blockers** for the named target and are **not** accepted here:

| Item | Target | Why not accepted |
|---|---|---|
| Missing customer ToS / privacy / DPA / subprocessors | C | Requires counsel (H-O2); agents do not invent legal text |
| No dogfood Yard on real cloud / no pilot | C | Product/ops (H-O4) |
| No non-fixture Bindle→cloud apply | C | Engineering + credentials (H-E5) |
| Unpublished npm with external install claims | B | Until allowlist + deliberate publish (H-E1b) |
| Secret history not scanned | A full go | Required before public flip (0011 §9) |

## Approval note

This instance **records** residual risk for interim ship work. It does **not** waive required CI, security, or contract gates for any target that still depends on them. Launch blockers cannot be waived by exception ([go-no-go-decision-record.md](../go-no-go-decision-record.md)).
