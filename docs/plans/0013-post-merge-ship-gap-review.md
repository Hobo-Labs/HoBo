---
type: Review Findings
title: "Post-merge ship-readiness gap review (main @ 61cfcdb9)"
description: "Second deep gap review after squash-merging ship stack #952–#956 into main. Re-scores Targets A/B/C, agent remediations closed on main, and residual human blockers still open."
tags: [hobo, plans, ship, gap-review, post-merge]
---

# Post-merge ship-readiness gap review

> **Audited at:** `61cfcdb9` on `origin/main` (2026-07-30).  
> **Prior reviews:** [`0011-ship-readiness-gap-review.md`](./0011-ship-readiness-gap-review.md) (pre-remediation), remediations in `0012-ship-remediation-plan` (a plan, not kept in the repository) and stacked PRs **#952–#956** (all **MERGED**).  
> **Method:** Recon of main tip artifacts, local gates (`docs:okf`, `docs:design-lint`, `ship:gap-closure`, unit tests), live Actions probe, npm registry probe, residual ledger + go/no-go instances.

## 1. Merge status (done)

| PR | Squash on main | Topic |
|---|---|---|
| [#952](https://github.com/Tyler-R-Kendrick/HoBo/pull/952) | `5c84218a` | ADR-0140 + readiness instances + plans 0011/0012 |
| [#953](https://github.com/Tyler-R-Kendrick/HoBo/pull/953) | `174450a6` | Truth-in-advertising |
| [#954](https://github.com/Tyler-R-Kendrick/HoBo/pull/954) | `9db6362e` | CI workflow honesty + S0 table |
| [#955](https://github.com/Tyler-R-Kendrick/HoBo/pull/955) | `91d51e07` | Publish hygiene |
| [#956](https://github.com/Tyler-R-Kendrick/HoBo/pull/956) | `61cfcdb9` | Residual ledger, secret-scan, gap-closure gate |

No open `ship/*` PRs remain. **Nothing left to merge for this stack.**

## 2. Executive summary (after merge)

| Dimension | Pre-0011 / mid-work | **Now on main** |
|---|---|---|
| Launch definition | Missing | **ADR-0140** + [`launch-ship-targets.md`](../design/launch-ship-targets.md) |
| Readiness instances | Empty contracts | **Populated** under [`docs/design/instances/`](../design/instances/) |
| Truth-in-advertising | 27 pkgs / 27 verbs drift | **~63 package manifests, 38 verbs, dual-bin fixed** |
| CI as release oracle | Red / no runners | **Still red** — H-V1 (`runner_name: null` on post-merge main runs) |
| npm install path | Unpublished + dual-bin risk | **Still unpublished**; prep (allowlist, private, dry-run workflow) **on main** |
| Local gates | — | **Green:** okf, design-lint, `ship:gap-closure`, tests |
| Hosted product (C) | Far | **Still far** (legal, dogfood, real apply) |

**Bottom line:** Agent-closable ship-hygiene is **on main**. Remaining gaps are **honest residuals** (human/account/product), not unmerged PRs.

## 3. Local verification (this audit)

| Command | Result |
|---|---|
| `pnpm run ship:gap-closure` | OK (9 residual IDs, dual-bin, CI markers, instance reconcile) |
| `pnpm run test:ship-gap-closure` | 3/3 pass |
| `pnpm run docs:okf` | OK |
| `pnpm run docs:design-lint` | OK |

## 4. Finding ID re-score (0011 IDs)

| ID | Status now | Evidence on main |
|---|---|---|
| **L0** | ✔ remediated | ADR-0140 |
| **O1** | ✔ remediated | instances dashboard + go-no-go + risks |
| **O2** | residual-human | H-O2 counsel |
| **O3** | residual-human | H-O3 staffed support |
| **O4** | residual-human | H-O4 dogfood/pilot |
| **O5** | ✔ strength | OSS hygiene + SECURITY |
| **O6** | residual-human | requirements unratified (C GA) |
| **O7** | informational | GAPS.md design-closed ≠ product |
| **O8** | ✔ remediated | accepted-risks single maintainer |
| **V1** | residual-human | H-V1 — post-merge Actions still `runner_name: null` |
| **V2** | ✔ remediated | S0 table pending-runner honesty (not bare TODO) |
| **V3** | ✔ remediated | `hobo-ci.yml` push to main |
| **V4** | ✔ remediated | stage-gate-s0 linux/windows artifacts |
| **E1** | residual-human | H-E1b — npm 404; prep done |
| **E2** | by-design + labeled | HONEST SCOPE / known-limitations |
| **E3** | residual-deferred + honesty | H-E3b; componentize HONEST SCOPE |
| **E4** | labeled | known-limitations / status |
| **E5** | residual-deferred | H-E5 |
| **E6** | residual-deferred | H-E6 |
| **E7** | labeled | private cloud-native + status |
| **E8** | residual-deferred | no registry package |
| **E9** | ✔ remediated | README/status counts |
| **E10** | ✔ remediated | `cli.bin` none; hobo has bins |
| **E11** | ✔ remediated | immature packages private (36 private / 27 public-ish) |
| **T1/T2** | residual-deferred | H-T1 |
| **T3** | positive | behavior surface |

**Orphan IDs:** none — every 0011 ID is either remediated on main or on residual ledger.

## 5. Target readiness (post-merge)

### A — OSS public

| Item | Status |
|---|---|
| ADR + instances | Met |
| Truth-in-advertising | Met |
| History secret scan | **Met (2026-07-30)** — re-run before visibility flip |
| SECURITY path | Documented |
| CI green | **Not required** for A cutline; H-V1 residual |
| **Repo visibility public** | **Still private** — **human org action** (not done) |

**Verdict:** **Conditional-go path fully instrumented on main.** Full go still needs human: flip visibility (+ re-run gitleaks at flip time).

### B — Local-first npm

| Item | Status |
|---|---|
| Allowlist + private + dual-bin + honesty | Met on main |
| Dry-run publish workflow | Met |
| Live `npm publish` | **Not done** (H-E1b; `@hobo/core` 404) |
| CI preferred for release | H-V1 open |

**Verdict:** **Prep conditional-go Met.** Live install story still **no-go**.

### C — Hosted beta/GA

**Verdict:** **No-go.** H-O2, H-O3, H-O4, H-E5, H-E6 dominate. No change from 0011 on product depth of live multi-cloud.

## 6. CI probe (post-merge)

Recent `main` runs after #956 still **failure** with **`runner_name: null`** (e.g. HoBo CI Fabric run `30587187498`, jobs ~3–12s). Confirms **H-V1 still open**. Do not treat red GitHub checks as product regressions for this stack.

## 7. New / residual gaps introduced by the ship work itself

| # | Finding | Class | Effort |
|---|---|---|---|
| **N1** | Repo remains **private** despite Target A conditional-go instrumentation | Human process | S (org setting) |
| **N2** | Post-merge main CI still theater-red (H-V1) — PR checks cannot prove stack quality | High-risk non-blocker | S account |
| **N3** | `hobo-code` bin added to product surface alongside `hobo` / `hobo-mcp` — ensure launch claims and allowlist stay aligned with ADR-0139 (HoBo Code) vs ADR-0140 ship targets | Launch note | S docs hygiene if marketing confuses them |
| **N4** | Dated instances are **2026-07-30 snapshots** — will stale; next ship review should append new dated instances rather than silent rewrite | Process | S each review |
| **N5** | Grandfathered proof debt (619-class) unchanged — still advisory | H-T1 | L |

No new **agent-closable** launch blockers found that are not already on residual ledger.

## 8. Recommended next human moves (priority)

1. **H-V1** — restore Actions runners so main is a real quality oracle.  
2. **Target A** — re-run gitleaks → flip repo public if desired; messaging stays pre-release.  
3. **Target B** — when H-V1 green: cut `0.1.0-alpha.x`, `NPM_TOKEN`, first allowlisted publish.  
4. **Target C** — counsel + dogfood + one real Bindle→cloud apply (quarters).

## 9. Residual human ledger (unchanged status)

Canonical: [`docs/design/instances/residual-human-blockers-2026-07-30.md`](../design/instances/residual-human-blockers-2026-07-30.md)

`H-V1` · `H-O2` · `H-O3` · `H-O4` · `H-E1b` · `H-E3b` · `H-E5` · `H-E6` · `H-T1` — all **open**.

## 10. Conclusion

| Question | Answer |
|---|---|
| Is the ship stack merged? | **Yes** — #952–#956 on main |
| Are agent remediations complete? | **Yes** — enforced by `ship:gap-closure` on main |
| Can we claim “shipped product”? | **No** — pre-release local monorepo + prep only |
| Closest next ship? | **Target A visibility flip** (human) then **Target B npm alpha** (human + H-V1) |

This review does **not** open a new implementation wave unless a new agent-closable finding appears; remaining work is residual/human by design.
