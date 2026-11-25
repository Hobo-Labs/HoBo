---
type: Reference
title: "HOBO-626 S2 Stage Gate — First Cloud + Yard proof record"
description: "Source issue: HOBO-626."
tags: [hobo, design]
---

# HOBO-626 — S2 Stage Gate proof record

Branch evidence for the Stage-2 gate drill. Executable proof lives at
[`src/draft/epic-proofs/s2-stage-gate-first-cloud-yard`](../../../../src/draft/epic-proofs/s2-stage-gate-first-cloud-yard/README.md).

## Branch Evidence

| Gate | Command |
|---|---|
| Unit + acceptance tests | `pnpm exec turbo run test --filter ./src/draft/epic-proofs/s2-stage-gate-first-cloud-yard` |
| CI drill script | `node --import tsx src/draft/epic-proofs/s2-stage-gate-first-cloud-yard/scripts/run-stage-gate-drill.ts` |

## Acceptance Mapping

| Stage-2 gate arm | Proof |
|---|---|
| Governed hello-bindle deploy to Cloudflare serves traffic | `simulateGovernedDeploy` + governed deploy test |
| Yard restart mid-deploy resumes within NFR-009 | `simulateYardRestartResume` + resume budget test |
| Provisioning failure → reverse-dependency compensation | `simulateCompensationRollback` + compensation order test |
| Gatekeeper blocks unsafe change with explainable reason | `simulateGatekeeperBlock` + compat/policy deny tests |
| Deployment timeline reconstructs the run | `reconstructDeploymentTimeline` + timeline test |

## Adversarial Coverage

- Gatekeeper bypass rejected (`gatekeeper.bypassed`).
- Resume over NFR-009 budget rejected (`resume.budget-exceeded`).
- Wrong compensation order rejected (`compensation.order-wrong`).
- Timeline temporal gap rejected (`timeline.gap`).

## Deferred

Live credentialed CI lane and S2-01 acceptance record attachment await merge of
`docs/design/stage-2-first-cloud-yard-acceptance.md` (HOBO-616 PR #676) and
production packages from S2-07..S2-10.
