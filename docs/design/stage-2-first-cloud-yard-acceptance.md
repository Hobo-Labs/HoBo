---
type: Reference
title: "Stage 2 Acceptance Record — First Cloud + Yard"
description: "Source issue: S2-01 (HoBo v1 Production Build, project Build S2)."
tags: [hobo, design]
---

# Stage 2 Acceptance Record — First Cloud + Yard

Source issue: S2-01 (HOBO-616).

Branch evidence:

- [`S2-01 proof record`](./proofs/s2-01-stage-2-first-cloud-yard/README.md)

This M0 record defines the accepted productionization scope for Stage 2 (First Cloud + Yard).
It does not build Yard runtime code, provider adapters, IaC apply, Postgres runtime ports, CLI
deploy verbs, Gatekeeper engines, or live cloud integration.

## Source And Pattern

This record follows the post-399 delta pattern. Minimum durable records for a cross-cutting capability delta are:

1. owning Linear project/issue family (Build S2: First Cloud + Yard);
2. M0 acceptance record in `docs/design/` with scope in/out and proof expectations (this file);
3. design-index row in [`index.md`](./index.md);
4. proof README under `docs/design/proofs/` plus executable proof under `src/draft/`;
5. traceability rows in [`traceability.md`](./traceability.md) linking issue + design record + proof;
6. blocked M1–M4 skeleton issues non-actionable until M0 is accepted.

**S2-02 through S2-11 remain non-actionable until reviewers accept this record.**

## Stage Goal And Runnable Gate

**Roadmap objective** (from [`docs/archive/roadmap.md`](../archive/roadmap.md), Stage 2 — First real
deploy):

> **Objective:** take a collected manifest and deploy it to one real cloud through a minimal Yard,
> with the event-sourced deployment lifecycle + crash-resume.

**Roadmap acceptance gate** (quoted verbatim):

> `hello-bindle` deploys to one real cloud and serves traffic; kill the Yard mid-deploy → resumes
> from the event log; a provisioning failure → saga compensation rolls back in reverse-dependency
> order; the deployment timeline projection reconstructs the run.

**Release criteria** (quoted verbatim from
[`docs/archive/requirements/requirements.md`](../archive/requirements/requirements.md), Release
criteria — Stage 2):

> **Stage 2:** reference Bindle deploys to a real cloud and survives a Yard restart mid-deploy; the
> Gatekeeper blocks an unsafe change with an explainable reason (policy gates + approval
> obligations + `can-deploy`, FR-050/051/052).

### Runnable gate assertions

Stage 2 is accepted only when all four assertions are green on a real cloud through the minimal Yard:

1. **`examples/hello-bindle` deploys to one real cloud through the Yard and serves traffic**, with
   the Gatekeeper (`contract-engine` + `can-deploy` + `policy-engine`) evaluating the Delta→Set
   promotion **before** apply.
2. **The Yard killed mid-deploy resumes from the event log**, and the deployment timeline projection
   reconstructs the run.
3. **A provisioning failure triggers saga compensation** that rolls back in reverse-dependency order
   (`saga.Compensated`).
4. **The Gatekeeper blocks an unsafe/incompatible change** with an explainable, event-sourced reason
   (`deployment.PlanRejected` / `compat.GateFailed` / `policy.Decided` evidence; FR-050/051/052).

## Decided Open Questions

### D1 — First provider: Cloudflare

**Decision:** Cloudflare is the first real-cloud provider for Stage 2
(`packages/providers/provider-cloudflare`, `@hobo/provider-cloudflare`).

**Rationale:** The S2 target-package layout names `provider-cloudflare` as the first provider home.
Cloudflare covers all three S2 capability ports required by the roadmap: `web`/`service` via
Workers, `kv` via Workers KV, and `objectStore` via R2. A single provider with all three ports
minimizes cross-provider wiring while proving the governed first deploy. The provider publishes a
Capability Manifest with equivalence-class mappings for those ports and must pass the
`@hobo/conformance` provider suite before S2 gate evidence is accepted.

**Rejected alternatives:**

| Alternative | Reason rejected for S2 |
|---|---|
| **Fly** | Fly re-enters via the Providers epic provider matrix in the Stage 4 multi-provider era; choosing Fly for S2 would delay the Cloudflare package scaffold and split first-deploy evidence across two provider tracks. |
| **local Docker** | Local Docker is a Camp/dev substrate, not a real cloud; Stage 2's gate explicitly requires deploy to **one real cloud** and traffic serving. Docker remains useful for offline/dev paths owned by Stage 1. |

### D2 — Per-resource IaC stacks (not grouped)

**Decision:** IaC apply wraps the **Pulumi Automation API** (`preview`/`apply`/`destroy`/`refresh`)
using **per-resource stacks** with a pluggable state backend and outputs (`@hobo/iac-pulumi`).

**Rationale:** Roadmap Stage 2 item 1 already prescribes wrapping the Pulumi Automation API with a
"per-resource stack model + state backend + outputs". Per-resource stacks bound blast radius to one
resource, map 1:1 onto ResourceActor reconcile, and let reverse-dependency compensation destroy
individual stacks during `saga.Compensated` rollback.

**Rejected alternatives:**

| Alternative | Reason rejected |
|---|---|
| **Grouped stacks** | Coarse blast radius: a failure or compensation step affects many resources at once; grouped stacks do not support per-node incremental reconcile aligned with ResourceActor FSM semantics. |

### D3 — Drift policy: detect-and-propose, never auto-remediate at S2

**Decision:** At Stage 2, drift handling is **detect-and-propose** only. The refresh loop emits a
DriftReport; remediation is routed as a proposed diff (`drift.DiffProposed`) requiring explicit
approval (`drift.RemediationRouted`). Autonomous remediation is deferred to the Operators & SRE
lane.

**Rationale:** Consistent with [`drift-reconciliation.md`](./drift-reconciliation.md), which
defines reconciliation states including `detected`, `classified`, `source-of-truth-pinned`,
`proposed`, and `reconciling` — with explicit approval before apply. Stage 2 must prove governed
deploy and compensation rollback before introducing autonomous heal loops.

**Rejected alternatives:**

| Alternative | Reason rejected for S2 |
|---|---|
| **Auto-remediate on refresh** | Autonomous apply of drift fixes bypasses Gatekeeper and human approval obligations; risks destructive convergence on production state before S2 gate evidence is stable. Deferred to Operators & SRE. |

### D4 — Deployed wasm-host target: HoBo component-host in OCI on provider container/service

**Decision:** The deployed wasm-host target is the **HoBo Wasmtime component-host packaged as an OCI
container** ([HOBO-28](https://linear.app/quickdeploy-ai/issue/HOBO-28/package-the-component-host-inside-an-oci-container-the-zero-infra))
running on the provider's container/service capability — **not** a translation to a provider-native
FaaS runtime.

**Rationale:** Keeps the component-host conformance suite
([HOBO-29](https://linear.app/quickdeploy-ai/issue/HOBO-29/build-the-hoboconformancecomponent-host-suite-the-portability-boundary))
as the portability boundary. The zero-infra OCI packaging path exercises the same host semantics
offline (Stage 1) and on the first cloud (Stage 2).

**Rejected alternatives:**

| Alternative | Reason rejected for S2 |
|---|---|
| **Provider-managed component hosts** ([HOBO-35](https://linear.app/quickdeploy-ai/issue/HOBO-35/spike-certify-an-opt-in-component-host-adapter-spinkube-or-provider) spike, e.g. SpinKube) | Opt-in follow-up: provider-native hosts split the conformance boundary and add certification surface before the first governed deploy is proven. Recorded as a later adapter spike, not the S2 default. |

## Owning Lanes

| S2 lane | Linear epic project | Target packages |
|---|---|---|
| Control-plane | Control Plane: Planner, Matching & Orchestrator | `packages/cloud` (`@hobo/cloud`); `packages/cli` (`@hobo/cli` — deploy verbs: `hobo plan`/`deploy`/`destroy`/`inspect deploy`; `hobo login` dev-SVID stub) |
| Provider / IaC | Providers, IaC & Build Adapters | `packages/iac/iac-pulumi` (`@hobo/iac-pulumi`); `packages/providers/provider-cloudflare` (`@hobo/provider-cloudflare`) |
| Data-plane | Data Plane: Event Sourcing, CQRS & Reactivity | `packages/runtimes/runtime-postgres` (`@hobo/runtime-postgres` — five runtime ports on Postgres: graphile-worker queue, NOTIFY/LISTEN streams, snapshots; must pass runtime-port conformance) |
| Governance | Contracts, Policy & Governance | `packages/policy` (`@hobo/policy`); `packages/contracts` (`@hobo/contracts`) |

## Promoted Draft Proofs

| Epic proof | What it proves for S2 | Simulate command |
|---|---|---|
| [`control-plane-planner-matching-orchestrator`](../../src/draft/epic-proofs/control-plane-planner-matching-orchestrator/README.md) | Planner → DeploymentPlan DAG with `match.Decided` evidence; Delta→Set apply; ResourceActor reconcile through mocked executor/driver boundaries; drift + partial-realize rollback; self-host bootstrap | `npm --prefix src/draft/epic-proofs/control-plane-planner-matching-orchestrator run simulate` |
| [`providers-iac-build-adapters`](../../src/draft/epic-proofs/providers-iac-build-adapters/README.md) | Provider contract + conformance catalog (incl. Cloudflare fixture); `realize()` → `IacProgram`/`BuildSpec` emission; IaC/build/driver adapter seams; drift/partial-apply/malicious-provider paths fail closed | `npm --prefix src/draft/epic-proofs/providers-iac-build-adapters run simulate` |
| [`data-plane-event-sourcing-cqrs-reactivity`](../../src/draft/epic-proofs/data-plane-event-sourcing-cqrs-reactivity/README.md) | Append-only events; replay==live equivalence; projections/Reactor push; GraphQL snapshot reads; poison-event quarantine | `npm --prefix src/draft/epic-proofs/data-plane-event-sourcing-cqrs-reactivity run simulate` |
| [`contracts-policy-governance`](../../src/draft/epic-proofs/contracts-policy-governance/README.md) | Gatekeeper composite decision over contract/policy/obligation/cost/provenance gates; deny-ceiling; fail-closed on engine unavailability; replayable decision evidence | `npm --prefix src/draft/epic-proofs/contracts-policy-governance run simulate` |

These four packages are **read-only promoted evidence**. S2-02..S2-11 consume their
`architecture/` folders (protobuf + CUE + PACT) without editing the draft packages.

## Target Packages

| Package path | npm name | Owning lane | S2 obligation |
|---|---|---|---|
| `packages/cloud` | `@hobo/cloud` | Control-plane | Yard Gateway, Planner, Orchestrator, ResourceActors, Executors |
| `packages/cli` | `@hobo/cli` | Control-plane | `hobo plan`/`deploy`/`destroy`/`inspect deploy`; `hobo login` dev-SVID stub |
| `packages/iac/iac-pulumi` | `@hobo/iac-pulumi` | Provider / IaC | Pulumi Automation API wrapper; per-resource stacks |
| `packages/providers/provider-cloudflare` | `@hobo/provider-cloudflare` | Provider / IaC | Cloudflare capability provider; conformance for `web`/`service`, `kv`, `objectStore` |
| `packages/runtimes/runtime-postgres` | `@hobo/runtime-postgres` | Data-plane | Five runtime ports on Postgres |
| `packages/policy` | `@hobo/policy` | Governance | Policy engine integration for Gatekeeper |
| `packages/contracts` | `@hobo/contracts` | Governance | Contract engine + `can-deploy` integration |

Each target package, when built by S2-02..S2-11, carries `src/`, package-local `data-models/`
(protobuf-first + CUE, no repo-wide catalog), `test/`, and `contracts/` (PACT pacts) per the
production layout convention in [`architecture.md`](./architecture.md).

## Scope In

- Author this M0 acceptance record with decided open questions, owning lanes, promoted proofs, and
  runnable gate restatement.
- Add one design-index row and four traceability rows.
- Add proof README at `docs/design/proofs/s2-01-stage-2-first-cloud-yard/README.md`.
- Document architecture obligations for S2-02..S2-11: PACT at every service boundary;
  protobuf-first records with CUE in package-local `data-models/`; parse-don't-validate derived
  types; CQRS/event-sourced state (actors emit events, never mutate read models).

## Scope Out And Non-Goals

- **No code under `packages/`** — owned by S2-02..S2-11; blocked until this record merges.
- **No edits** to the four promoted `src/draft/epic-proofs/*` packages.
- **No live cloud calls, credentials, or production runtime code** in this record's PR.
- **Stage-1 exit evidence** (local runtime, hello-bindle offline, replay==live) — owned by S1-25
  (HOBO-615).
- **Identity/SVID/token-broker real implementation** — Stage 3.
- **Multi-provider + Fly/AWS/Azure** — Stage 4.
- **Drift auto-remediation** — Operators & SRE lane; S2 uses detect-and-propose only (D3).

## Follow-Up Gate

Do not create or start **S2-02 through S2-11** until reviewers accept this M0 record. Every S2
skeleton issue must cite [`stage-2-first-cloud-yard-acceptance.md`](./stage-2-first-cloud-yard-acceptance.md)
as its acceptance authority.

Blocked follow-up issues (non-exhaustive; see Linear project Build S2):

| Issue | Scope |
|---|---|
| S2-02 | `@hobo/runtime-postgres` production runtime ports |
| S2-03..S2-11 | Remaining S2 lane implementation slices (cloud, CLI, IaC, provider, policy, contracts) |

## Stage Gate Rehearsal Evidence (S2-09)

The executable S2 gate is `.github/workflows/s2-stage-gate.yml` (added for S2-09). It has two lanes
per the repo's no-live-E2E-in-the-blocking-lane policy:

- **rehearsal** (CI, mocked, no cloud) — the in-memory Yard rehearsal encoded by the production
  `@hobo/cloud` and `@hobo/contracts` suites. The Yard is constructed exactly as the gate specifies:
  a `@hobo/runtime-local` `createRuntimeLocalEventStore` + `createInMemoryActorHost`
  (`@hobo/data`) + `createInProcessExecutor` over a mock `IacProvider`, with
  `createRegistryFromProviders([createCloudflareProvider()])` (`@hobo/provider-cloudflare`) as the
  catalog projection. Gate body: `pnpm --filter @hobo/cloud test && pnpm --filter @hobo/contracts test`.
- **live** (`workflow_dispatch`-only, `environment: s2-live-cloud`, keyless `id-token: write`,
  guaranteed `if: always()` teardown) — the same rehearsal against a real Cloudflare Yard. **Held**:
  no live-cloud wiring exists yet, so the deploy/teardown steps are documented placeholders.

### Runnable-gate assertions covered by the rehearsal

| Runnable gate assertion (from above) | Production test | Assertion |
|---|---|---|
| (2) Yard killed mid-deploy resumes from the event log; timeline projection reconstructs the run | `packages/cloud/test/orchestrator.test.ts` — "resumes a deploy killed mid-Provisioning by folding the event stream" | A crash during `resource.Provisioning` of `database` leaves no terminal fact; a fresh actor host/broker/executor over the same EventStore replays to `deployment.Deployed` with exactly one `resource.Provisioning` for `database` (no duplicate restart); the `DeploymentView` projection rebuilds the run from zero. |
| (3) Provisioning failure triggers reverse-dependency saga compensation | `packages/cloud/test/orchestrator.test.ts` — "rolls back and destroys provisioned actors in reverse-dependency order" | A seeded `web` apply failure drives `deployment.RolledBack`, then `resource.Destroyed` for `api → cache → database → network` (dependents-first); the projection shows `web: failed`, `network: destroyed`. |
| (4) Gatekeeper blocks an unsafe/incompatible change with an explainable, event-sourced reason (FR-050/051/052) | `packages/cloud/test/gatekeeper.test.ts` — "DENIES a seeded breaking contract change with an explainable machine-readable reason" | A breaking contract candidate is denied with `decision: "deny"`, a machine-readable reason `code: "required-field-removed"` naming the removed field `tenantId`, while still emitting `policy.Decided` (governed-by-default even on allow). |
| (1)/(4) Rejection carries machine-readable remediation an agent can act on | `packages/cloud/test/planner.test.ts` + `gateway.test.ts` — "unsatisfiable resource -> deployment.PlanRejected" | An unsatisfiable port yields `deployment.PlanRejected` carrying a remediation `code: "capability.port-unavailable"` with a `requiredPort` and human remediation text — the agent-self-correction input. |

### Local rehearsal run (2026-07-17)

CI runners are down account-wide (infrastructure fault), so the CI-run cells are **pending runner
restoration**. The gate body was run locally against the production packages and is green:

```text
pnpm --filter @hobo/cloud test        ->  7 files / 39 tests passed
pnpm --filter @hobo/contracts test    ->  4 files / 18 tests passed
```

Assertion (1) — a real cloud deploy that serves traffic — is **not** covered by the rehearsal lane
(it is the held `live` lane); the rehearsal proves the crash-resume, compensation, and Gatekeeper
arms against the mocked Yard. This is an honest scope boundary: the S2 record is accepted on a real
cloud only when the `live` lane runs.
