---
type: Reference
title: "Stage 4 Multi-Cloud Acceptance & Productionization Plan"
description: "Source issue: S4-01."
tags: [hobo, design]
---

# Stage 4 Multi-Cloud Acceptance & Productionization Plan

Source issue: S4-01 (Linear HOBO-637, project **Build S4: Multi-Cloud**).

Executable proofs (promoted draft epic packages):

- [`providers-iac-build-adapters`](../../src/draft/epic-proofs/providers-iac-build-adapters/README.md)
- [`networking-connectivity-dns-relay`](../../src/draft/epic-proofs/networking-connectivity-dns-relay/README.md)
- [`control-plane-planner-matching-orchestrator`](../../src/draft/epic-proofs/control-plane-planner-matching-orchestrator/README.md) — **Planner resolution + Matching slices only** (orchestrator/Delta-Set slice promoted at Stage 2)
- [`portability-registry-distribution`](../../src/draft/epic-proofs/portability-registry-distribution/README.md)

Branch evidence:

- [`build-s4-multi-cloud-m0 proof record`](./proofs/build-s4-multi-cloud-m0/README.md)

This M0 record defines the accepted productionization scope for Stage 4 (Multi-Cloud). It does not
build provider adapters, Planner/Matching runtime code, Junction overlay execution, Relay/DNS
productionization, or the `examples/multi-cloud-shop` fixture.

Pattern: `Post-399 Cross-Cutting Capability Deltas`
and exemplar [`meta-cloud-broker.md`](./meta-cloud-broker.md). The S4-01 issue body, this record, and
the four epic-proof simulate commands are the reviewable source of truth.

## M0 Acceptance Record

Stage 4 (Multi-Cloud) is accepted for S4-02..S4-09 implementation only when this record and the
executable draft proofs agree on:

- the stage goal and five-part acceptance gate;
- scope in, scope out, and non-goals;
- production package map and required package anatomy;
- promoted proof → package promotion plan;
- the three Stage-4 hook decisions (overlay mesh, Planner objective, Crossplane coexistence);
- Matching placement inside `packages/cloud`;
- implementation architecture obligations inherited by follow-ups; and
- the follow-up gate blocking S4-02..S4-09 until this record is Done.

## Stage Goal And Gate

**Stage objective** ([`roadmap.md`](../archive/roadmap.md#stage-4--multi-provider--wiring-depth)):
prove the agnostic thesis — the same Bindle deploys to multiple clouds via mapping rules, with
cross-provider connectivity and typed provider-specific optimization, with no app edits.

**Release criterion** ([`requirements.md`](../archive/requirements/requirements.md) Stage 4 bullet):
*one Bindle deploys to ≥2 clouds; cross-cloud mTLS works; switching a resource's provider touches
only config; resource-driven Resource Definitions/Matching + Packs (FR-060/061/062) participate in
resolution.*

**Five-part acceptance gate** (roadmap acceptance gate + requirements, with design citations):

1. **Unedited Bindle on ≥2 clouds ([NFR-001](../archive/requirements/requirements.md))** —
   *One **unedited** Bindle deploys to multiple providers; provider details never leak into the
   agnostic core. "Unedited" = the `bindle()` definition + app `src/` byte-identical across
   targets; only the `camp()`/`yard()` mapping/env vary.* `examples/multi-cloud-shop` deploys the
   same bindle to two providers via mapping rules and asserts identical topology
   ([ADR-0024](./adr/07-portability-extensibility.md#adr-0024), [`control-plane.md#plan-04`](./control-plane.md#plan-04)).

2. **Cross-cloud mTLS keyed by SVIDs** — cross-cloud services connect over mTLS keyed by SVIDs;
   connectivity tiers follow native private → interconnect → overlay mesh → public + mTLS
   ([`security-networking.md#plan-12`](./security-networking.md#plan-12)).

3. **`deployment.PlanRejected` for unsatisfied `require`** — a `require`d-but-unoffered capability
   yields `deployment.PlanRejected` with a precise reason (provider capability feedback on
   [`control-plane.md#plan-04`](./control-plane.md#plan-04)).

4. **Camp re-home / provider switch without app edits ([FR-004](./sdk-api.md#plan-02), [ADR-0011](./adr/01-architecture-core.md#adr-0011), [yard-first-placement](./adr/yard-first-placement.md))** —
   switching a resource's provider is a **Yard/Trail concern**: re-attach the Camp to a different Yard (or run a Trail that re-homes it) — no app/Bindle change. Camps do not own provider selection.

5. **Resource Definitions/Matching + Packs ([FR-060](../archive/requirements/requirements.md)/[FR-061](../archive/requirements/requirements.md)/[FR-062](../archive/requirements/requirements.md))** —
   Resource Definitions, Matching, and certified Resource Packs participate in resolution;
   Matching emits `match.Decided` with recorded evidence
   ([`platform-engineering.md#plan-25`](./platform-engineering.md#plan-25)).

## Scope In

- Restate the stage goal, five-part gate, and NFR-001 portability contract verbatim where cited above.
- Name production package targets (`packages/providers/provider-aws`, `provider-azure`, `cloud`,
  `junctions`, `examples/multi-cloud-shop`) with `@hobo/*` publish names and required anatomy.
- Map each of the four promoted `src/draft/epic-proofs/*` packages to its production destination(s)
  and simulate command.
- Decide the three Stage-4 hooks: overlay-mesh technology, Planner objective when multiple providers
  satisfy, and Crossplane coexistence.
- Record Matching placement: `packages/cloud/src/matching/` with protobuf+CUE in
  `packages/cloud/data-models/`.
- Document implementation obligations for S4-02..S4-09: PACT at every boundary; protobuf-first +
  package-local CUE; parse-don't-validate; CQRS/event-sourced actors (`deployment.Planned`,
  `deployment.PlanRejected`, `match.Decided`); adapters on `@hobo/core` ports passing
  `@hobo/conformance`.
- Record layering invariant ([NFR-020](../archive/requirements/requirements.md)): `apps → adapters →
  sdk/runtime → core`; provider packages are adapters and never imported by `packages/cloud` except
  through `@hobo/core` ports.
- Record Planner resolution order: per-boundary > per-tier > whole-app mapping styles, then
  `prefer`/`require` negotiation; rationale on `deployment.Planned`; `.with(...)` inert for
  non-resolved providers ([FR-005](./sdk-api.md#plan-02)).
- Record certified Pack rule: Registry listings become *available* to Matching after
  signature/provenance/conformance/trust verification; Matching must still decide — never auto-select.
- Add design index row, traceability row, and proof README per HOBO-524 pattern.
- Block S4-02..S4-09 until this record is merged and indexed.

## Scope Out And Non-Goals

- **S4-02..S4-09 implementation** — provider-aws/azure adapters, Planner/Matching/connectivity-tier
  runtime in `packages/cloud`, `packages/junctions`, WireGuard overlay, Relay/DNS productionization,
  and `examples/multi-cloud-shop` fixture build-out are owned by the S4-02..S4-09 follow-up family.
- **Stage-2 acceptance record** — owned by S2-01 (HOBO-616); orchestrator/Delta-Set slice already
  promoted there.
- **Forge-generated providers** — Stage 5 family.
- **HA/cost-objective Planner tuning and Registry distribution productionization** — Stage 6 family.
- **Any edits under `src/draft/`** — promoted proofs are cited read-only; this issue does not move
  proof code.
- **New `packages/*` or `examples/*` directories** — planned targets only; folders are created by
  follow-ups.
- **Live cloud calls, credentials, or production runtime** in this M0 PR.

## Production Package Map

| Target | Publishes | Contents | Required anatomy |
|---|---|---|---|
| `packages/providers/provider-aws` | `@hobo/provider-aws` | Capability-port adapter, Capability Manifest, equivalence classes, typed `.with(...)` builders; must pass `@hobo/conformance` | `src/`, `data-models/` (protobuf + CUE), `test/`, `contracts/` (PACT), `wit/` where WIT surface owned |
| `packages/providers/provider-azure` | `@hobo/provider-azure` | Same adapter anatomy as AWS | Same |
| `packages/cloud` | `@hobo/cloud` | Planner resolution (mapping styles, `prefer`/`require` negotiation, rationale on `deployment.Planned`); **Matching** (`src/matching/`); connectivity-tier *planning* (tier selection, policy ceilings, egress annotation on `bind` edges) | Same |
| `packages/junctions` | `@hobo/junctions` | Yard Junction halves, cross-cloud bind execution, SVID-keyed mTLS wiring; implements `@hobo/core` network/junction ports | Same |
| `examples/multi-cloud-shop` | (fixture) | Unedited-Bindle two-cloud fixture asserting identical topology via mapping rules | Bindle + Camp mappings + gate assertions (not a published package) |

Primary IaC for provider realize paths remains Pulumi Automation API embedded ([TR-041](../archive/requirements/requirements.md), [ADR-0006](./adr/01-architecture-core.md#adr-0006)).

## Promoted Proofs

| Draft epic proof | Promotes into | Run command | S4 slice |
|---|---|---|---|
| [`providers-iac-build-adapters`](../../src/draft/epic-proofs/providers-iac-build-adapters/README.md) | `@hobo/provider-aws`, `@hobo/provider-azure`, `@hobo/iac-pulumi` seams | `pnpm --prefix src/draft/epic-proofs/providers-iac-build-adapters run simulate` | Provider contract + conformance catalog, AWS/Azure/GCP matrix, multi-cloud shop portability gate, `realize()` → mocked `IacProgram`/`BuildSpec` |
| [`networking-connectivity-dns-relay`](../../src/draft/epic-proofs/networking-connectivity-dns-relay/README.md) | `@hobo/junctions`, connectivity planning inputs on `@hobo/cloud` | `pnpm --prefix src/draft/epic-proofs/networking-connectivity-dns-relay run simulate` | Connectivity tier selection, policy ceilings, mTLS validation, mirrored per-Yard Junction halves, Relay, tenant-aware ingress |
| [`control-plane-planner-matching-orchestrator`](../../src/draft/epic-proofs/control-plane-planner-matching-orchestrator/README.md) | `@hobo/cloud` Planner + Matching modules only | `pnpm --prefix src/draft/epic-proofs/control-plane-planner-matching-orchestrator run simulate` | Deterministic DeploymentPlan with `match.Decided` evidence, region/objective decisions — **not** orchestrator/Delta-Set (Stage 2) |
| [`portability-registry-distribution`](../../src/draft/epic-proofs/portability-registry-distribution/README.md) | Registry install → Matching availability seam on `@hobo/cloud` | `pnpm --prefix src/draft/epic-proofs/portability-registry-distribution run simulate` | Certified listing install *available to Matching without being selected automatically*, digest-pinned resolution, yank/fail-closed behavior |

## Stage-4 Hook Decisions

### H1 — Overlay-mesh technology

| | |
|---|---|
| **Decision** | WireGuard data plane with HoBo-managed, Tailscale-style control-plane coordination (peer/key distribution keyed by SVIDs). |
| **Rationale** | [`security-networking.md#plan-12`](./security-networking.md#plan-12) already orders connectivity tiers with overlay mesh as tier-4 fallback when native private peering/interconnect is unavailable; WireGuard is the documented default overlay mechanism and aligns with SVID-keyed identity. |
| **Consequences** | `@hobo/junctions` owns overlay fallback execution; Planner annotates `bind` edges with tier + egress; native private and interconnect tiers are attempted first. |
| **Deferred alternatives** | eBPF/Cilium-ClusterMesh as a later optimization path; full Tailscale product dependency rejected (HoBo-managed control plane only). |

### H2 — Planner objective when multiple providers satisfy

| | |
|---|---|
| **Decision** | Deterministic, non-economic default for Stage 4: explicit mapping first (per-boundary > per-tier > whole-app), then `require`/`prefer` negotiation, then **stay-on-one-cloud** (minimize cross-provider `bind` edges/egress), then stable **lexicographic** tie-break by provider id; rationale recorded on `deployment.Planned`. |
| **Rationale** | [`sdk-api.md#plan-02`](./sdk-api.md#plan-02) and [`control-plane.md#plan-04`](./control-plane.md#plan-04) already define mapping precedence and auditable planning; stay-on-one-cloud minimizes cross-cloud wiring cost/complexity before FinOps objectives exist. |
| **Consequences** | Stage 4 plans are replayable without cost/latency telemetry; cross-provider `bind` count is a explicit Planner signal on `deployment.Planned`. |
| **Deferred alternatives** | Cost/latency Pareto objectives deferred to Stage 6 FinOps ([`reliability-observability-cost.md#plan-05`](./reliability-observability-cost.md#plan-05)). |

### H3 — Crossplane coexistence

| | |
|---|---|
| **Decision** | Pulumi Automation API remains the sole embedded v1 IaC mechanism ([TR-041](../archive/requirements/requirements.md), [ADR-0006](./adr/01-architecture-core.md#adr-0006)). Crossplane coexists only as a possible future alternate `IacProvider` adapter behind the `@hobo/core` IaC port. |
| **Rationale** | Stage 4 must not fork the resource model or take a Crossplane runtime dependency while proving portability; the IaC port already abstracts engine choice. |
| **Consequences** | No Crossplane XRDs/compositions as HoBo's resource model in Stage 4; provider adapters emit Pulumi programs through `@hobo/iac-pulumi`. |
| **Deferred alternatives** | OpenTofu/CDKTF as additional `IacProvider` adapters behind the same port (TR-041 alternates). |

## Matching Placement Decision

| | |
|---|---|
| **Decision** | Matching lives inside `packages/cloud` as `src/matching/` with protobuf+CUE records in `packages/cloud/data-models/`. |
| **Rationale** | Stage 4's only Matching consumer is the Yard Planner resolution path; colocation keeps `match.Decided` emission and `deployment.Planned` rationale in one deployable unit and avoids premature package fragmentation. |
| **Extraction trigger** | Extract to standalone `packages/matching` when a second consumer exists (e.g. Registry-side Pack scoring at Stage 6). |
| **Consequences** | S4-02..S4-09 implement Matching behind the `@hobo/cloud` public seam; PACT contracts cover Matching ↔ Planner and Matching ↔ Registry catalog inputs. |

## Implementation Architecture Obligations

Follow-ups S4-02..S4-09 inherit ([`AGENTS.md`](../../AGENTS.md), [`technical-standards.md`](./technical-standards.md)):

- PACT contracts at every service boundary (SDK/runtime, runtime/provider, planner/matching, junction/network).
- Protobuf-first records with CUE constraints in each package's local `data-models/` folder (no repo-wide catalog).
- Parse-don't-validate derived types at boundaries.
- CQRS/event-sourced state: actors emit `deployment.Planned`, `deployment.PlanRejected`, `match.Decided`; projections rebuild from the log — never mutate read models in place.
- Provider and junction packages are adapters implementing `@hobo/core` ports and passing `@hobo/conformance`.

## Authority And Owning Lanes

| Lane | Owning initiative | Target packages |
|---|---|---|
| Provider/IaC | Providers, IaC & Build Adapters | `@hobo/provider-aws`, `@hobo/provider-azure`, `@hobo/iac-pulumi` |
| Planner + Matching + connectivity planning | Control Plane: Planner, Matching & Orchestrator | `@hobo/cloud` |
| Cross-cloud wiring | Networking, Connectivity, DNS & Relay | `@hobo/junctions` |
| Pack install → Matching availability | Portability, Registry & Distribution | Registry seam consumed by `@hobo/cloud` Matching |
| Portability gate fixture | Example apps | `examples/multi-cloud-shop` |

## Authoritative Dependencies

- [`architecture.md`](./architecture.md) — layering, Camp/Bindle/Junction/Yard scopes.
- [`sdk-api.md#plan-02`](./sdk-api.md#plan-02) — mapping styles and `.with(...)`.
- [`control-plane.md#plan-04`](./control-plane.md#plan-04) — Planner, DeploymentPlan, capability feedback.
- [`security-networking.md#plan-12`](./security-networking.md#plan-12) — connectivity tiers and mTLS.
- [`platform-engineering.md#plan-25`](./platform-engineering.md#plan-25) — Resource Definitions, Matching, Packs.
- [`adr/01-architecture-core.md#adr-0011`](./adr/01-architecture-core.md#adr-0011) — Camp/Bindle separation.
- [`adr/07-portability-extensibility.md#adr-0024`](./adr/07-portability-extensibility.md#adr-0024) — portability (NFR-001).

## Follow-Up Gate

**S4-02..S4-09 must not start until this record is merged and indexed** (`docs/design/index.md` +
`docs/design/traceability.md`). Adjacent decisions route to owning families: Forge-generated
providers → S5; HA/cost-objective Planner tuning and Registry distribution productionization → S6.

Do not create or start S4-02..S4-09 implementation until reviewers accept this M0 record and its
executable proof mapping. Every S4 skeleton issue must cite
[`stage-4-multi-cloud-acceptance.md`](./stage-4-multi-cloud-acceptance.md).
