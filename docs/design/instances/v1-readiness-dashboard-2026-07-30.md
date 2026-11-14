---
type: Reference
title: "V1 readiness dashboard instance — 2026-07-30"
description: "Populated V1 readiness dashboard snapshot, reconciled after ship remediations WP-A–E (2026-07-30). Honest red/yellow; secret scan Met; dual-bin and private flags fixed; human residuals still open."
tags: [hobo, design, ship, instances, readiness]
---

# V1 readiness dashboard — 2026-07-30

> **Contract:** [`v1-readiness-dashboard.md`](../v1-readiness-dashboard.md)  
> **Ship targets:** [ADR-0140](../adr/07-portability-extensibility.md#adr-0140) / [`launch-ship-targets.md`](../launch-ship-targets.md)  
> **Owner:** single maintainer (Tyler Kendrick) — all readiness roles unbound except as noted  
> **Not a ship decision.** See go/no-go instances for gate outcomes.  
> **Reconciled:** after WP-B–E (truth-in-advertising, CI honesty, publish prep, residual ledger, secret-scan Met).

## Field status

| Field | Status | Value / evidence | Empty-state / fail-closed reading |
|---|---|---|---|
| **Cutline** | 🔴 Red | No ratified **hosted** v1 cutline instance. Interim ship cutlines defined by **ADR-0140** (A = S0/S1 hygiene; B = S1 offline prep; C = S2+ legal/dogfood/apply) but **not signed** as product GA boundary. Requirements suite unratified (0011 O6). | Missing product cutline → cannot claim shared v1 **hosted** boundary. |
| **Blockers** | 🔴 Red (C) / 🟡 (A/B) | **Still open (human):** Actions runners (**H-V1**); customer ToS/privacy for C (**H-O2**); staffed support C (**H-O3**); dogfood/pilot C (**H-O4**); live npm publish (**H-E1b**); real jco (**H-E3b**); live multi-cloud apply (**H-E5**); production OIDC (**H-E6**); proof waves (**H-T1**). **Remediated (agent):** S0 acceptance no longer bare `TODO` — **pending runner restoration** honesty ([build-s0-stage-gate-acceptance.md](../build-s0-stage-gate-acceptance.md)); dual-bin fixed; immature packages `private: true`; history secret scan **Met**. Residual ledger: [`residual-human-blockers-2026-07-30.md`](./residual-human-blockers-2026-07-30.md). | Open human blockers keep C red; A/B may proceed on honesty + residual acceptance. |
| **Milestone health** | 🟡 Yellow | Design-intent [`GAPS.md`](../../../GAPS.md) closed (design only). Engineering real (~58 package manifests, composed CLI). S0/S1 local maturity strong; S2+ incomplete. No Linear milestone refresh attached. | Missing live milestone refresh → yellow. |
| **Evidence links** | 🔴 Red (CI) / 🟢 local | **Local/design evidence strong** (docs:okf, design-lint, `ship:gap-closure` on tip). **CI as release oracle still broken** — Actions jobs fail without runner assignment (`runner_name: null`); do **not** claim green main. S0 table: local evidence + **pending runner restoration** (not bare TODO). Secret scan evidence: go-no-go-repo-public condition 3 **Met**. | CI missing → red for CI-proven claims only. |
| **Accepted risks** | 🟡 Yellow | [`accepted-risks-2026-07-30.md`](./accepted-risks-2026-07-30.md): single maintainer, CI outage, synthetic wasm, in-memory default — **recorded, still live**. | Risks on file and still live. |
| **Owners** | 🔴 Red | All roles effectively **single maintainer (Tyler Kendrick)**. Bus factor recorded (0011 O8). No counsel/staffed support for C. | Unowned multi-role lanes → red for C. |
| **Last verified** | 🟡 Yellow | Dashboard **reconciled 2026-07-30** after remediations on stack tip. Local gates + gap-closure exercised. **No claim that Actions is green.** History secret scan Met; re-run before public flip. | Local verification present; CI-proven verification still red/yellow. |

## Per-target readiness (rollup)

| Target | Rollup | Notes |
|---|---|---|
| **A — OSS public** | 🟡 Conditional-go | Launch definition + honesty + **secret scan Met**. H-V1 residual accepted. Visibility flip still human. Instance: [`go-no-go-repo-public-2026-07-30.md`](./go-no-go-repo-public-2026-07-30.md). |
| **B — Developer tooling** | 🟡 Prep conditional-go / live no-go | Dual-bin fixed; private flags + allowlist + dry-run workflow Met. **Live npm publish no-go** (H-E1b). Instance: [`go-no-go-developer-tooling-2026-07-30.md`](./go-no-go-developer-tooling-2026-07-30.md). |
| **C — Hosted beta/GA** | 🔴 No-go | Legal, dogfood, real apply, staffed support open. No beta/RC/GA instance filed. |

## Explicit non-claims

- CI is **not** green on this dashboard (H-V1 open).
- npm packages are **not** published (H-E1b open).
- Default `hobo up` is **not** real multi-cloud apply.
- `@hobo/componentize` path remains **synthetic contract-shaped wasm** (H-E3b residual).
- This dashboard does **not** approve Target C.
- Secret scan is **not** still open for Target A (it is **Met** 2026-07-30; re-run before flip).

## Revisit

| Item | Date |
|---|---|
| Re-run gitleaks immediately before visibility flip | at flip time |
| Re-run dashboard after H-V1 runner restoration | when Actions assigns runners |
| Refresh after live npm publish (H-E1b) | first registry publish |
| Target C legal/dogfood/apply evidence | when those handoffs land |
