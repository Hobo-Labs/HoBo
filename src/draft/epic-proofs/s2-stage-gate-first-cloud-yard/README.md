# S2 Stage Gate — First Cloud + Yard (HOBO-626)

Independent draft POC for **S2-11**: closes the Stage-2 gate as a scripted,
CI-runnable drill under `examples/hello-bindle` without live cloud credentials.

## Contract Surface

- `createS2StageGateDrillContract()` pins fixture, provider, NFR-009 resume
  budget, credentialed CI lane, and S2-01 acceptance record path.
- `simulateGovernedDeploy()` models Gatekeeper-gated `hobo deploy` to
  Cloudflare with live traffic assertion.
- `simulateYardRestartResume()` kills the Yard mid-deploy and resumes from the
  append-only event log within the NFR-009 30s budget.
- `simulateCompensationRollback()` seeds a provisioning failure and emits
  `saga.Compensated` in reverse-dependency order.
- `simulateGatekeeperBlock()` blocks an unsafe Delta→Set promotion with
  explainable `compat.GateFailed` / `policy.Decided` + `deployment.PlanRejected`
  evidence.
- `reconstructDeploymentTimeline()` folds deployment/saga events into a
  replayable timeline projection.
- `runStageGateDrill()` runs all five gate arms for the credentialed CI drill
  script.

## Acceptance Mapping

| Acceptance (HOBO-626) | Executable proof |
|---|---|
| `hobo deploy` lands hello-bindle on real Cloudflare and serves traffic | `governed deploy lands hello-bindle on Cloudflare and serves traffic` |
| Yard killed mid-deploy resumes from event log within NFR-009 budget | `Yard killed mid-deploy resumes from event log within NFR-009 budget` |
| Seeded provisioning failure compensates in reverse-dependency order | `seeded provisioning failure compensates in reverse-dependency order` |
| Gatekeeper blocks unsafe change with explainable reason | `Gatekeeper blocks unsafe change with explainable event-sourced reason` |
| Deployment timeline projection reconstructs the run | `deployment timeline projection reconstructs the full run` |
| Drill script green for credentialed CI lane | `runStageGateDrill passes all five gate arms` + `npm run drill` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Deploy bypasses Gatekeeper | `adversarial: deploy without Gatekeeper is rejected` |
| Resume exceeds NFR-009 | `adversarial: resume exceeding NFR-009 budget fails closed` |
| Compensation wrong order | `adversarial: wrong compensation order fails closed` |
| Timeline gaps after replay | `adversarial: timeline with temporal gap fails closed` |

## Boundary

Mocked boundaries only — no live Cloudflare, Yard process, Postgres event
store, or credentialed CI runner. Production promotion to
`examples/hello-bindle` drill wiring and `packages/cloud` awaits S2-07..S2-10
merge. Evidence attaches to `docs/design/stage-2-first-cloud-yard-acceptance.md`
(S2-01) after that record merges.

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/epic-proofs/s2-stage-gate-first-cloud-yard
node --import tsx src/draft/epic-proofs/s2-stage-gate-first-cloud-yard/scripts/run-stage-gate-drill.ts
```

## Architecture Evidence

- `architecture/` — protobuf + CUE for drill record shapes.
- `architecture/pacts/` — PACT boundary for the drill consumer.
- `ADR.md` — parse-don't-validate and event-architecture vocabulary.

## Maintenance

Docs-only companion: `docs/design/proofs/hobo-626-s2-stage-gate-first-cloud-yard/README.md`.
