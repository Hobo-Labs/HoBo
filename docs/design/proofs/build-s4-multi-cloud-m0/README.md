---
type: Reference
title: "Build S4 Multi-Cloud M0 Proof"
description: "Source issue: S4-01."
tags: [hobo, design]
---

# Build S4 Multi-Cloud M0 Proof

This proof backs the Stage 4 (Multi-Cloud) M0 acceptance record and productionization plan.

## Branch Evidence

- Issue: HOBO-637 (S4-01)
- Source M0 record: [Stage 4 Multi-Cloud Acceptance & Productionization Plan](../../stage-4-multi-cloud-acceptance.md)
- Pattern reference: [HOBO-524 Post-Core Cross-Cutting Delta Pattern](../hobo-524-post-core-cross-cutting-delta-pattern/README.md)

### Promoted epic proofs (focused gates)

Promoted epic proofs stay read-only for S4-01. Two simulate scripts omit an inline
`--import tsx` flag; set `NODE_OPTIONS='--import tsx'` (memory flag only if your runner
rejects combined flags) before the `pnpm --prefix … run simulate` gates so Node resolves
TypeScript sources on Node 22+.

| Package | Simulate command |
|---|---|
| [`providers-iac-build-adapters`](../../../../src/draft/epic-proofs/providers-iac-build-adapters/README.md) | `pnpm --prefix src/draft/epic-proofs/providers-iac-build-adapters run simulate` |
| [`networking-connectivity-dns-relay`](../../../../src/draft/epic-proofs/networking-connectivity-dns-relay/README.md) | `pnpm --prefix src/draft/epic-proofs/networking-connectivity-dns-relay run simulate` |
| [`control-plane-planner-matching-orchestrator`](../../../../src/draft/epic-proofs/control-plane-planner-matching-orchestrator/README.md) | `pnpm --prefix src/draft/epic-proofs/control-plane-planner-matching-orchestrator run simulate` |
| [`portability-registry-distribution`](../../../../src/draft/epic-proofs/portability-registry-distribution/README.md) | `pnpm --prefix src/draft/epic-proofs/portability-registry-distribution run simulate` |

## Acceptance Mapping

| Record claim | Proof package | Run command |
|---|---|---|
| Unedited Bindle deploys to ≥2 clouds; provider options do not leak; unsatisfied `require` rejected | `providers-iac-build-adapters` | `pnpm --prefix src/draft/epic-proofs/providers-iac-build-adapters run simulate` |
| Cross-cloud mTLS, connectivity tiers, policy ceilings, mirrored Junction halves | `networking-connectivity-dns-relay` | `pnpm --prefix src/draft/epic-proofs/networking-connectivity-dns-relay run simulate` |
| Planner resolution + Matching with `match.Decided` evidence (orchestrator out of S4 scope) | `control-plane-planner-matching-orchestrator` | `pnpm --prefix src/draft/epic-proofs/control-plane-planner-matching-orchestrator run simulate` |
| Certified Packs available to Matching without auto-select; digest-pinned resolution; yank fail-closed | `portability-registry-distribution` | `pnpm --prefix src/draft/epic-proofs/portability-registry-distribution run simulate` |
| Five-part gate, package map, hook decisions, Matching placement documented | M0 record + design index + traceability | `docs/design/stage-4-multi-cloud-acceptance.md`; `grep stage-4-multi-cloud-acceptance docs/design/index.md docs/design/traceability.md` |
| S4-02..S4-09 follow-up gate | M0 record Follow-Up Gate section | Review only — implementation blocked until record merged |

## Adversarial Coverage

The promoted proofs fail closed on: provider option leakage into the agnostic core; unsatisfied
`require` without `deployment.PlanRejected`; policy widening past connectivity ceilings; Relay SSRF
pivot attempts; implicit provider-default Matching selection; yanked listing deploy without
remediation; and offline import with live egress. Stage 4 M0 does not claim live multi-cloud deploy
— only that the architecture evidence runs deterministically via simulate.
