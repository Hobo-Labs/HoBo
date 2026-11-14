---
type: Reference
title: "Go/no-go — repo-public (Target A) — 2026-07-30"
description: "Conditional-go practice instance for ADR-0140 Target A (OSS public). History secret scan Met (2026-07-30); CI runner restoration (H-V1) remains open accepted residual; visibility flip is human."
tags: [hobo, design, ship, instances, go-no-go]
---

# Go/no-go decision — `repo-public` — 2026-07-30

> **Contract:** [`go-no-go-decision-record.md`](../go-no-go-decision-record.md)  
> **Ship target:** **A — OSS public** ([ADR-0140](../adr/07-portability-extensibility.md#adr-0140), [`launch-ship-targets.md`](../launch-ship-targets.md))  
> **Dashboard:** [`v1-readiness-dashboard-2026-07-30.md`](./v1-readiness-dashboard-2026-07-30.md)  

## Decision record

| Field | Value |
|---|---|
| **Gate** | `repo-public` |
| **Decision** | **conditional-go** |
| **Approver role** | Release owner (single maintainer: **Tyler Kendrick** — all other roles unbound) |
| **Evidence links** | ADR-0140; launch-ship-targets; 0011 §7 Target A must-list; SECURITY.md; WP-B honesty; **history gitleaks clean 2026-07-30** ([pre-public-secret-scan.md](../pre-public-secret-scan.md)); **no** green Actions URL claimed |
| **Blocker deltas** | **Resolved by agents (2026-07-30):** launch definition L0 (ADR-0140); truth-in-advertising (WP-B); full-history secret scan clean (condition 3 Met). **Still open:** Actions runner assignment (**H-V1** — accepted residual for A, not hard-fail); unratified hosted product cutline (not required for A); **human org action** to flip visibility. |
| **Accepted risks** | See [`accepted-risks-2026-07-30.md`](./accepted-risks-2026-07-30.md): single maintainer; CI outage; synthetic wasm (launch note for A); in-memory default (launch note for A — not a product claim). |
| **Expiry / revisit** | **2026-08-30** or immediately before visibility flip (re-run gitleaks) / after runner restoration, whichever first |

## Conditions for full go (Target A)

| # | Condition | Status at instance date |
|---|---|---|
| 1 | Launch definition published (ADR-0140 + human summary) | **Met** — WP-A docs |
| 2 | Truth-in-advertising pass (package/verb counts, no full-product overclaim) | **Met** — WP-B (README, site status, package READMEs, known-limitations) |
| 3 | Full git-history **secret scan** with clean or remediated findings | **Met (2026-07-30)** — `gitleaks detect --source . --redact` over 1215 commits: **no leaks found** (exit 0). Runbook: [`pre-public-secret-scan.md`](../pre-public-secret-scan.md). **Re-run immediately before the actual visibility flip.** |
| 4 | Working SECURITY contact path | **Met** in docs — SECURITY.md updated; confirm contact works before public flip |
| 5 | Actions runners restored (preferred) | **Open** — human H-V1; **not** hard-fail for conditional-go under ADR-0140 S0/S1 hygiene cutline |

## What this decision is not

- Not npm publish authorization (Target B).
- Not hosted beta/GA (Target C).
- Not a claim that CI is green.
- Not counsel approval of customer ToS (not required for A).
- Not a claim that repository visibility has been flipped (human org setting).

## Outcome summary

**Conditional-go for Target A:** history secret scan (condition 3) is **clean as of 2026-07-30** (re-run immediately before the visibility flip). Condition **5** (Actions runners) remains an accepted residual risk until H-V1 completes — public flip does not require green CI if messaging stays pre-release and local gates pass. Visibility flip itself is still a **human org action** (not claimed done here). Public messaging must say **Target A / OSS public / pre-release**.
