---
type: Reference
title: "Platform Engineering: Matching, Environments, Drivers & GitOps"
description: "This capability doc covers how platform engineers shape HoBo deploys: Resource Definitions & Matching, environments (Camps, Deployment Sets & Deltas), the Driver taxonomy (Resource"
tags: [hobo, design]
---

# Platform Engineering: Matching, Environments, Drivers & GitOps

This capability doc covers how platform engineers shape HoBo deploys: Resource Definitions & Matching, environments (Camps, Deployment Sets & Deltas), the Driver taxonomy (Resource Packs & Workload Profiles), and reach (the Relay, GitOps publisher & Pipelines).

## Plan 25

### Why this exists
Developers declare *what* they need (a `database`, IfC-style with `.allow()`, [Plan 21](./authoring-resources-wiring.md#plan-21)). Platform engineers declare *how* it's realized — and crucially, **differently per environment**: managed-HA Postgres in prod, a cheap in-cluster Postgres in an ephemeral preview. A **Resource Definition** is that rule; **Matching** picks the right one for the deploy context. This is **dynamic configuration management**: the *same Bindle* resolves to different infra without app edits.

### A Resource Definition
For an abstract port (`type` + optional `class`), a definition says which **provider + driver + options + co-provisioned resources** realize it, plus the **matching criteria** that select it. Definitions are **WIT-interface-typed** ([Plan 20](./wasm-runtime-wit.md#plan-20)) and may be **AI-generated** ([Plan 23](./generated-stack.md#plan-23)).
```ts
// platform/resource-defs.ts — authored by platform engineers (TS; YAML form also supported)
import { defineResource } from "@hobo/sdk";
import { aws } from "@hobo/provider-aws";

export const postgresProdHa = defineResource({
  type: "database", engine: "postgres", class: "ha",   // the port it satisfies
  provider: aws,
  driver: "terraform",                                   // Plan 27 driver taxonomy
  with: aws.rds({ instanceClass: "db.r6g.large", multiAz: true }),
  match: { envType: "production", resourceClass: "ha" }, // criteria (Plan: specificity below)
});

export const postgresEphemeral = defineResource({
  type: "database", engine: "postgres",
  driver: "container",                                   // in-cluster Postgres for cheap previews
  with: { image: "postgres:16" },
  match: { envType: "ephemeral" },
});

// projection sinks are definitions too — this is the data-architect-autonomy knob (Plan 39)
export const ticketsSinkProd = defineResource({
  type: "projection-sink", paradigm: "relational",       // SQL / document / kv / graph / vector / lake / olap
  provider: aws, driver: "terraform",
  with: aws.rds({ instanceClass: "db.r6g.large" }),
  mapping: "./projections/tickets.mapping",              // WIT-record fields → backend columns (Plan 39/ADR-0050)
  match: { envType: "production", resourceId: "tickets" },
});
```
A **`projection-sink`** definition is how a data architect places a developer's read model on a backend **without touching app code** ([Plan 32](./data-plane.md#plan-32)/[ADR-0050](./adr/03-data-plane.md#adr-0050)): the `paradigm` is a matching dimension, and the `mapping` declares how the read-model WIT record lands in that backend. The developer owns the logical record + queries; the architect owns the mapping + sink — the autonomy split *is* this Matching boundary.

### Matching (specificity-scored selection)
For a needed resource in context `{ envType, app, env, tenant, resourceType, resourceClass, resourceId }`, the Planner gathers all definitions of that `type`, keeps those whose criteria fully match, **scores by specificity**, and selects the highest (ties → next-most-specific). Criteria dimensions: `envType` · `app` · `env` · `resourceClass` · `resourceId` (+ `tenant`).
```
match: {}                                              # score 0  (catch-all)
match: { envType: "production" }                       # score 1
match: { envType: "production", resourceClass: "ha" }  # score 2
match: { envType: "production", app: "shop", resourceClass: "ha" }  # score 3  (wins)
```
**HoBo twist — auditable matching.** The winning definition, its score, and the rejected candidates are recorded as a **`match.Decided`** event ([Plan 11](./data-plane.md#plan-11)) → a replayable answer to "*why did this resource land on this infra?*" (a gap in Humanitec's opaque selection). The dashboard renders it ([Plan 7](./developer-experience.md#plan-07)).

```mermaid
flowchart LR
  REQ["needed resource<br/>(type, class, id) + context"] --> GATH["gather definitions of this type"]
  GATH --> FILT["filter: criteria match<br/>+ hard require capability"]
  FILT -->|none satisfy require| REJ["deployment.PlanRejected<br/>(precise reason)"]
  FILT --> RANK["rank lexicographically:<br/>specificity → priority → objective → stable tiebreak"]
  RANK --> PICK["select winner<br/>(record match.Decided + ranking + tie flag)"]
  PICK --> REAL["realize via provider + Driver (Plan 27)"]
  REAL --> NODE["node in DeploymentPlan DAG (Plan 3/4)"]
```

### The selection algorithm — deterministic, on-path ([ADR-0033](./adr/01-architecture-core.md#adr-0033), [ADR-0088](./adr/01-architecture-core.md#adr-0088))
Selection is a **pure function** of `(catalog snapshot, deploy context, objective setting)` — and, for the credit-aware **`maximize-credits`** objective, of the **pinned `CreditLedgerView@seq` recorded into the decision** ([ADR-0071](./adr/01-architecture-core.md#adr-0071) §3). No clock, RNG, network, or model is read **live on the path**: the time-dependent credit/budget/free-tier state is captured as a *pinned input*, not sampled at decision time, so selection stays unit-testable without a cloud and **identical on replay** (the determinism property [Plan 9](./generated-stack.md#plan-09) asserts of the Planner). The pipeline:
1. **Gather** all definitions of the requested `type`.
2. **Filter** to candidates whose criteria match the context **and** whose provider satisfies the resource's hard **`require`** capabilities (`Capability.satisfies` ([Plan 4](./control-plane.md#plan-04)) = `full` → accept; `prefer` may degrade with a `PlanWarning`; `require` miss → reject). If none satisfy `require` → **`deployment.PlanRejected`** with a precise, agent-correctable reason.
3. **Rank lexicographically:** (a) **specificity score** (above) → (b) an **explicit `priority`** (optional integer on a definition, for deliberate platform override) → (c) the **default objective** (soft; configurable `cost`|`latency`|`single-provider`|`carbon`|`maximize-credits` per Yard/Camp, **default = min-cost within constraints** — [Plan 5](./reliability-observability-cost.md#plan-05); the credit-aware `maximize-credits` mode is the **Dispatcher**, [ADR-0071](./adr/01-architecture-core.md#adr-0071)) → (d) a **stable deterministic tiebreak** (definition id, lexicographic).
4. **Record** the winner + full ranking + rejected candidates + the objective used + a **tie flag** + the **catalog content-hash** in `match.Decided`.

**True ties never block.** If candidates are equal on specificity, `priority`, *and* objective, the stable tiebreak (definition id, lexicographic) still yields a deterministic winner, and a `PlanWarning` + tie flag is recorded so a platform engineer can add an explicit `priority` to disambiguate. **The tiebreak is stable only within a catalog snapshot:** because Resource Definitions are auto-generatable and Pack-importable, adding/renaming a definition can change which of two equal-scoring candidates wins on the next plan — so `match.Decided` records the **catalog content-hash**, making a winner change **attributable to a catalog change** rather than appearing as nondeterminism.

HOBO-55 pins the exact scoring vector in [ADR-0088](./adr/01-architecture-core.md#adr-0088): specificity is a grouped `0..3` score over environment, ownership, and resource groups, with a deterministic detail vector (`resourceId`, `resourceClass`, `tenant`, `app`, `env`, `envType`) before priority/objective/id. Its executable golden vectors live in [`../../src/draft/technical-proofs/matching-specificity-vectors`](../../src/draft/technical-proofs/matching-specificity-vectors).

**AI/solvers are advisory, off the deploy path.** `hobo plan` may *surface* a cheaper alternative; the **generation pipeline** may *generate* candidate definitions ([Plan 23](./generated-stack.md#plan-23)); an LLM may *suggest* definitions at authoring time — none select at deploy time, so replay + `match.Decided` stay honest. A constraint solver / LLM selector on-path is not part of the model ([ADR-0033](./adr/01-architecture-core.md#adr-0033)).

### Node placement and system workloads (iteration hooks)

Matching selects **which** Resource Definition realizes a resource; the component-host scheduler seam now covers substrate-realized scheduler hints, but HoBo still does not define a full Nomad-class node-placement language. The surfaces below are recorded here so the competitor parity tracker ([Nomad mapping](../competitors/nomad.md#primitive-mapping)) cannot silently overclaim; tracked as gap GAP-003 in [`GAPS.md`](../../GAPS.md) and Linear issue [HOBO-671](https://linear.app/quickdeploy-ai/issue/HOBO-671).

- **Affinity / anti-affinity / topology spread** — soft/hard co-location and distribution across nodes/zones/Camps. Existing coverage is partial: Planner step 4 "Region & colocation" ([Plan 4](./control-plane.md#plan-04)), matching criteria, and Workload Profile scheduler hints realized through the component-host scheduler ([ADR-0108](./adr/01-architecture-core.md#adr-0108)); a full Nomad-class constraint language is not yet committed.
- **System (per-node) workloads** — Nomad system jobs run one instance per eligible node/node class; HoBo's sketch is Yard/operator/system Bindles per Camp or node class, with no design text yet.
- **Raw-exec / Java / QEMU legacy hosts** — OCI/container/VM adapters are designed as provider choices ([Plan 20](./wasm-runtime-wit.md#plan-20), [Plan 4](./control-plane.md#plan-04), BuildProvider packer/firecracker); a non-containerized raw-exec host adapter has no design coverage yet.

When a later design pass expands scheduler hints into a full constraint language, upgrade the tracker rows and replace the relevant bullet with the new design/ADR anchor.

### Mapping is sugar over default definitions
A Camp's **inline mapping overrides** ([Plan 2](./sdk-api.md#plan-02)) are **not** a separate system and **do not author the cloud provider** — they **compile to Resource Definitions under the selected Yard provider** ([yard-first-placement ADR](./adr/yard-first-placement.md)):
- Yard `provider: azure` → `match: {}` default definitions per port on Azure for Camps attached to that Yard.
- Camp `resourceMappings` / tier overrides → definitions matched by service model or `resourceId` **within** that Yard provider.
- Explicit `defineResource({ … match: { envType: "production" } })` → definitions that win by specificity over `{}` defaults.
So a solo platform engineer authors the **Yard** (provider + optional IaC) and attaches Camps that only need runtime/env preferences; a platform team adds explicit definitions (with classes + env-type matching) that win by specificity. **Precedence** = pure matching score (explicit definitions naturally outscore the `{}` defaults). Legacy Camp-level `defaultProvider` / `tiers` / `bindings` cloud pins are **rejected** at parse (`Camp must not select a cloud provider`) — map resources under the Yard instead.

**Where the `{}` defaults come from — the Yard provider ships them.** Each provider package ships a **default Resource Definition** per capability it supports: its `equivalence` map (abstract port → that cloud's resource class) plus `realize()` ([Plan 4](./control-plane.md#plan-04)), and `.register(provider)` registers them. So a **Yard that declares provider + IaC** (with Camps attached or inferred under it) matches the *entire* generated manifest with **zero** per-resource Camp config; `defineResource` and Camp mapping overrides exist to **override** a default, never to bootstrap cloud selection. The same holds for an AI-generated provider: conformance proves its built-in Definitions satisfy each claimed port before it is signed and registered. And declaring a Camp at all is optional: once you've **approved default providers** *and* **enabled inferred-Camp approval** (a toggle, or a policy that passes — [ADR-0074](./adr/02-identity-security.md#adr-0074); off by default), the cloud **infers** a Camp **under a selected/inferred Yard** and auto-places/rebalances the Bindle (the Dispatcher, [ADR-0071](./adr/01-architecture-core.md#adr-0071)) with no human in the loop — that pair is the happy path. An explicit Camp **pins** env/runtime/residency or mapping overrides when inference shouldn't decide; **Camps move between Yards via Trails**, not via Camp-local cloud pins.

### Resource classes
`class` (`standard`/`ha`/`encrypted`/…) is declared on the resource ([Plan 21](./authoring-resources-wiring.md#plan-21)) and is a first-class matching dimension, so one logical port can have several platform realizations.

### Co-provisioning & the graph
A definition may declare co-provisioned resources (e.g. a bucket + its IAM policy); these become extra nodes/edges in the DeploymentPlan DAG with output flow via placeholders ([Plan 21](./authoring-resources-wiring.md#plan-21)). The Planner ([Plan 4](./control-plane.md#plan-04)) consumes definitions; the Orchestrator ([Plan 4](./control-plane.md#plan-04)) executes the graph.

### AI-generated definitions
Given a backend's Capability Manifest + a target context, the **generation pipeline** ([Plan 6](./ai-native-agent-auth.md#plan-06)/[Plan 23](./generated-stack.md#plan-23)) can generate candidate Resource Definitions (and bundle them as **Resource Packs**, below), validated sandboxed against conformance — so platform breadth isn't human-bottlenecked.

### Definition versioning & external-standards posture ([ADR-0144](./adr/07-portability-extensibility.md#adr-0144))
A Resource Definition's **id names a stable request/realization shape**. Compatible additions (new optional options, added features, cost updates) mutate in place and surface as `resourcedef.Updated`; **breaking changes require a new definition id** (or an explicitly recorded conversion definition) with the old id deprecated — never a silent rewrite. Selection stays attributable because `match.Decided` pins the **catalog content-hash** (above): a winner flip is a catalog change, not nondeterminism. Conceptually this mirrors Crossplane's XRD/Composition split — XRD ≈ the definition's request schema, Composition ≈ its provider/driver realization, Claim ≈ the developer's port consumption — and OAM's application-first stance reinforces the Bindle model; the mapping is **vocabulary alignment only**: the core IR, Matching semantics, and event families never depend on any external spec ([Crossplane capture](../competitors/crossplane.md#primitive-mapping), [ADR-0144](./adr/07-portability-extensibility.md#adr-0144)).

### Environments: Camps with an environment type
A **Camp** ([Plan 2](./sdk-api.md#plan-02)) is a **provider-neutral deployment target** until attached to a Yard — one environment placement that hosts the durable runtime. **The Yard owns provider selection**; the Camp **infers** provider/runtime/IaC from Yard attachment (or Yard placement policy when inferred) ([yard-first-placement ADR](./adr/yard-first-placement.md)). Its **environment type** (`development`/`staging`/`production`/`ephemeral`/custom) is the **primary matching dimension** above: the same Bindle resolves to different infra on a `production` Camp vs an `ephemeral` one, purely via specificity. A multi-cloud `production` is **several Camps under one or more Yards** ([Plan 4](./control-plane.md#plan-04)); each Yard holds that provider's cross-Camp policy. A Camp can be **cloned** from one with a prior successful deploy through the platform SDK/dashboard/MCP surface, producing a draft Delta to tweak and ship (`env.Cloned`, [Plan 11](./data-plane.md#plan-11)). **Camps can move between Yards via Trails** — Trails define the cross-cloud re-home recipe, not Camp-local provider pins.
```ts
// a camp() object's inline mapping
camps: {
  prod:    { envType: "production" },
  staging: { envType: "staging" },
  preview: { envType: "ephemeral", ttl: "72h" },   // ephemeral defaults
}
```
**Ephemeral / preview environments** are per-PR Camps, created on PR open (by CI or a Pipeline, below) and reaped by **auto-TTL**, each with isolated event streams ([Plan 12](./security-networking.md#plan-12)). Mapping **cheap variants** to `envType: ephemeral` (in-cluster DB, scale-to-zero wasm, shared cluster) makes previews cheap by construction ([Plan 5](./reliability-observability-cost.md#plan-05)).

**Request-level isolation (sandbox lanes) — the cheaper default for previews & branch testing ([ADR-0076](./adr/02-identity-security.md#adr-0076)).** Cloning a whole Camp per PR is the heavy option; the default is a **sandbox lane** over a **shared baseline** environment (the bridge-to-Kubernetes model): a lane = a **signed, principal/tenant-bound lane token** (not a bare header) + a set of **boundary-mode** overrides ([Plan 9](./generated-stack.md#plan-09)/[Plan 23](./generated-stack.md#plan-23)). The token is **enforced fail-closed at every membrane hop and on the `EventEnvelope.lane` for async** — requests/events carrying it route to the lane's **forked** services (a `hobo dev --fork` build via the Relay (below), or a branch deploy), everything else stays baseline, and a hop/subscriber that can't prove in-lane provenance **denies rather than leaking onto the baseline**. A fork must **satisfy the boundary contract at lane join** (a runtime check, distinct from deploy-time `can-deploy`, [Plan 29](./contracts-policy-flags.md#plan-29)); **baseline aggregates fork-on-touch** so a lane write never appends the real stream ([Plan 32](./data-plane.md#plan-32)). Concretely, fork-on-touch is **not** contending for the baseline's single-writer lease: a touched aggregate folds the baseline stream up to the fork point, then appends the lane's events to a **separate lane-scoped stream id** (`lane:<id>:<aggregateKey>`) **with its own lease** — reads are a **read-through merge** (baseline-up-to-fork-point ⊕ lane tail), and a **lane request never takes the baseline single-writer lease**, so a concurrent baseline writer is unaffected. **No fork event is ever delivered to a baseline subscriber/saga** (the `EventEnvelope.lane` deny-by-default filter, [ADR-0076](./adr/02-identity-security.md#adr-0076) R1), and a **choreography saga is lane-scoped** — a baseline saga never reacts to a lane event and vice-versa. **Real external side effects default to `mock`/`record`** (a `live` grant is itself gated, [ADR-0076](./adr/02-identity-security.md#adr-0076) R3); the lane runs under a **resource budget** + isolation tier ([ADR-0012](./adr/02-identity-security.md#adr-0012)) so a bad fork can't degrade the baseline; read-through honors data-classification ([ADR-0060](./adr/02-identity-security.md#adr-0060)). A lane is **tenant-scoped**, has a **TTL**, and reap **drains in-flight requests + fails/migrates running sagas** before discarding the overlay; lane cost is a metering dimension ([ADR-0039](./adr/02-identity-security.md#adr-0039)). A **preview environment** is then either a sandbox lane (the default) or a full ephemeral Camp, each with a preview URL; the same lanes carry **self-healing experiments** and **lane-bounded chaos** ([ADR-0076](./adr/02-identity-security.md#adr-0076)).

### Deployment Sets (immutable) + Deltas (mutable)
> **Delivered by HoBo.CD ([ADR-0182](./adr/01-architecture-core.md#adr-0182), D2, D5).** The model below is implemented by
> `@hobo/cd`; [continuous-delivery.md](./continuous-delivery.md) is the full
> design.

HoBo produces a **manifest IR** per deploy ([Plan 21](./authoring-resources-wiring.md#plan-21)); Sets and Deltas are the two halves of that model, as **projections over the event log** ([Plan 11](./data-plane.md#plan-11)) rather than bespoke tables — so promote/rollback/preview inherit replay + audit for free:
- **Freight** is what moves between environments: the immutable, content-addressed promotion unit for one Bindle (declaration hash, artifact digests, source, provenance). It is discovered by pull from any registry or Git host, or ingested from any CI by OIDC trusted publishing or an in-toto/SLSA attestation (`freight.Recorded`).
- **Deployment Set** = the immutable, content-addressed resolved configuration of one Bindle in one Camp: Freight's declaration Matched against that Camp's topology. Recorded as `set.Created`. A stateful resource's **cross-Camp replication topology** (single-writer / active-active-eventual / pinned, [ADR-0040](./adr/01-architecture-core.md#adr-0040)) is part of this resolved config, selected like any other matching dimension.
- **Deployment Delta** = the proposed transition from a Camp's current Set to a new one, with an intent (`promote`, `rollback`, `config`, `topology`, `failover`, `depart`, `posture-remediate`, …). Deltas preview, pass the gate, then **apply** to make the new Set the Camp's desired state (`delta.Opened` / `delta.Updated` / `delta.Applied` / `delta.Rejected`).
- **Desired state and observations are separate streams.** A Camp's spec stream holds its desired Set; a fenced per-Camp **reconciler** converges the target and reports to the Camp's status stream. The reconciler is the only delivery mutator.

```mermaid
flowchart LR
  FR["Freight (immutable)"] --> M["Matching per target Camp"]
  M --> D["Delta (proposed transition)"]
  D --> REV["preview / gate / approval<br/>(Gatekeeper, windows, lineage)"]
  REV --> APPLY["apply -> new desired Set (immutable)"]
  APPLY --> REC["reconciler converges by pull<br/>(only changed nodes)"]
  REC --> OBS["status observations -> verification"]
```

Because `match.Decided` (above) is part of the same record, "why did preview get the cheap DB?" is always answerable.

The M0 projection contract is pinned by the executable HOBO-50 proof in
[`proofs/hobo-50-deployment-set-delta`](./proofs/hobo-50-deployment-set-delta/index.md):
it folds `set.Created` + `delta.*`, verifies stable Set content addressing, computes
add/update/remove diffs, rejects overlapping Deltas and absent-resource references, and treats an
environment group as Yard-level orchestration over member Camps rather than a new config layer.
`@hobo/cd` promotes that proof's semantics into its `sets` module tests.

### The `can-deploy` gate, promote, rollback, incremental
Applying a Delta runs the **Gatekeeper** ([Plan 29](./contracts-policy-flags.md#plan-29)) against the **versions already running in the target Camp** (read from the event log): contracts-compatible (`compat.GatePassed/Failed`) AND policy-allows — with **obligations** that can *reshape* the rollout (e.g. "allow but require canary" forces a canary) — AND evals/conformance/cost, AND the Camp's change windows. Incompatible producer/consumer skew blocks the promotion with a precise reason + suggested fixes (shim, deploy-order, migration window). **App-data schema migrations compose here:** when the Freight's declaration changes data shape, promotion runs Trails `expand` → hosting transition → soak → `contract` ([Plan 32](./data-plane.md#plan-32)); each phase passes the same gate, and a **destructive contract phase that would break a still-running version is blocked** (`compat.GateFailed`).

- **Promote** = carry the **same Freight** into the target Camp, **re-run Matching for that Camp**, and apply the result as a Delta, gated. HoBo does not copy the source Camp's Set: the artifact bytes are identical everywhere (promote, never rebuild), while infrastructure may legitimately differ per Camp and is shown as `infrastructure_diff`. Lineage decides *whether* Freight may reach a Camp: only after upstream qualification (a PASS verification) plus soak, or an unexpired approval.
- **Rollback** = zero exposure, then a Delta back to the predecessor Set through the same gate; stateful resources keep state ([Plan 5](./reliability-observability-cost.md#plan-05)). **A completed `contract` phase is a boundary:** because a destructive `contract` has already dropped the old shape, rollback past it is **refused**, and the refusal names the **compensating `expand`** (re-add the shape) to run first. Rollback before or within `expand`/`backfill` is safe.
- **Incremental deploy** = the reconciler diffs the desired Set against what it observed and converges **only changed nodes** through the Orchestrator's ResourceActors ([Plan 4](./control-plane.md#plan-04)) or the hosting-transition coordinator — fast, low-blast-radius.

All of these are sequences of events → time-travel, audit, and DR-as-replay for free.

### Drivers (generalizing HoBo's IaC adapters)
HoBo's `IacProvider` ([Plan 4](./control-plane.md#plan-04)) becomes one **Driver** among a taxonomy. A Resource Definition names a driver; a capability provider uses it to realize the resource.

| Driver | Realizes via | Notes |
|---|---|---|
| **`terraform`** | Pulumi Automation API / OpenTofu | primary; any provider; per-resource state ([Plan 4](./control-plane.md#plan-04)) |
| **`template`** | render manifests/config (Go-template/CUE) | K8s manifests, config files, CRDs |
| **`echo`** | none — **adopt an externally-managed/BYO resource** | pass declared connection info through as outputs; HoBo reads, doesn't provision (gap-filler) |
| **`container`** | run arbitrary provisioning in a **Firecracker Executor** | Pulumi/CFN/scripts; HoBo already sandboxes Executors ([Plan 4](./control-plane.md#plan-04)) |
| **`custom-webhook`** | call a self-hosted HTTP service | signed (SVID) request; returns outputs + optional manifests; any stack |

```ts
export interface Driver {
  id: "terraform" | "template" | "echo" | "container" | "custom-webhook";
  provision(input: { context: MatchContext; inputs: unknown; oldState?: unknown })
    : Promise<{ outputs: Record<string, unknown>; manifests?: unknown[]; state?: unknown }>;
  destroy(input: { context: MatchContext; state: unknown }): Promise<void>;
  refresh?(input: { context: MatchContext; state: unknown }): Promise<DriftReport>;
}
```
Drivers run inside sandboxed Executors with short-lived scoped creds ([Plan 12](./security-networking.md#plan-12)); outputs flow back as events and into placeholders ([Plan 21](./authoring-resources-wiring.md#plan-21)). `echo` resources are read-only by default (drift behavior is an iteration hook).

### Resource Packs & Workload Profiles
A **Resource Pack** is a shareable, versioned bundle of Resource Definitions for a common need (e.g. "AWS data tier", "in-cluster preview stack"). Packs live in the **Registry** ([Plan 6](./ai-native-agent-auth.md#plan-06)) with provenance + conformance reports, can be imported and customized by matching, and can be **AI-generated** from a backend's Capability Manifest and certified sandboxed ([Plan 23](./generated-stack.md#plan-23)). `hobo add <pack>` installs one.

**Scopes are distributable too, not just definitions.** The scope objects themselves are first-class **listings** ([ADR-0062](./adr/07-portability-extensibility.md#adr-0062)): an org ships a **preconfigured Camp/Yard/Junction** — or a **side-loaded Bindle** — as an npm package or a structured git repo that exports the constructed scope (signed + certified like any listing), so a team runs `npm i @acme/yard-prod` (or `hobo add`) and imports a golden topology instead of re-authoring it. A Yard — including the **hosted HoBo cloud** — can publish a **pre-approved catalog** of these (providers, scopes, packs) that production policy may require ([ADR-0074](./adr/02-identity-security.md#adr-0074)); the hosted cloud ships one by default so a Bindle deploys with zero platform setup.

A **Workload Profile** declares **how a service is realized** on a target — the realization HoBo chooses for a `service`/`web` resource:
- `wasm-component` (default, [Plan 20](./wasm-runtime-wit.md#plan-20)) · `container` (OCI fallback) · `serverless-function` · `vm`/`microvm` ([Plan 21](./authoring-resources-wiring.md#plan-21)).
- Platform engineers define custom profiles (e.g. a Dapr profile, a batch-job profile); the profile influences the manifest/Set the deploy produces ([Plan 21](./authoring-resources-wiring.md#plan-21)) and which provider compute port is used.
- Selected by the resource (default per target) or pinned via `.with(...)`.
- A profile may carry scheduling constraints (spread/anti-affinity, drain policy) realized per substrate by the component-host scheduler ([ADR-0108](./adr/01-architecture-core.md#adr-0108)).

**Placeholders / output references** align to Humanitec syntax and HoBo's lazy references ([Plan 21](./authoring-resources-wiring.md#plan-21)) — resource outputs `${resources.<type>.<class>#<id>.outputs.<name>}` and context `${context.app|env|envType|res.id|class|type}` — resolved at deploy from the resolved graph; unresolved refs fail planning with a precise error.

### The HoBo Relay (deploy into private networks)
> **Superseded for delivery by the HoBo.CD agent ([ADR-0182](./adr/01-architecture-core.md#adr-0182), D5).** Delivery into a
> private network no longer uses a reverse tunnel. An **agent-mode reconciler**
> runs inside the boundary (`hobo deploy agent run`), connects **outbound over
> HTTPS only** to the Station's delivery feed, authenticates with a key-bound
> JWT-SVID and a DPoP proof on every request, reads its Camp's desired state,
> converges it with credentials that never leave the network, and reports
> observations back. The Station holds no target credential and never opens a
> connection to the agent. Agents enroll with double opt-in (two recorded
> grants). The reverse-tunnel design below is kept as history and for non-delivery
> uses only.

A hosted Yard can't reach a customer's private cluster/cloud. The **HoBo Relay** was designed as a lightweight proxy inside that network:
- **Outbound-only reverse tunnel:** the Relay dials the Yard over **TCP 443** (no inbound ports, no exposed endpoints); TLS + authenticated with an SVID ([Plan 6](./ai-native-agent-auth.md#plan-06)).
- **Executors run behind the Relay:** IaC/build/driver execution happens inside the private network; **credentials never leave it**; the Yard sends work + receives `exec.*`/outputs over the tunnel.
- One Relay can serve multiple clusters/targets, routing by target id — enabling regulated/sovereign deploys ([Plan 12](./security-networking.md#plan-12)) and self-hosted parity.

The shape was wrong for pull delivery: a tunnel lets the Yard push work in, whereas a reconciler that reads desired state needs only an outbound feed.

```mermaid
flowchart LR
  STATION["Station (delivery feed)"] -. desired state / observations over outbound HTTPS .- AG["HoBo.CD agent<br/>(customer private network)"]
  AG --> PRIV["private cluster / cloud / DB"]
```

### Air-gapped / sovereign mode (fully disconnected) ([ADR-0036](./adr/07-portability-extensibility.md#adr-0036))
The Relay is the *connected-private* path. A **fully disconnected / sovereign** environment has no path out at all, so air-gap is a **first-class self-hosted Yard profile**: the whole control plane (Yard + Registry + Identity + Executors + runtime + optional models) runs **inside the boundary with zero egress**.
- **Artifacts enter via signed offline bundle import** (`hobo registry import <bundle>`): provider plugins, Capability Manifest, Resource Packs, base images, and optional model weights, each with **SLSA provenance + conformance reports**, **verified in-boundary against the same trust boundary** as the live Registry (signature + provenance + conformance) — one-way-transfer (sneakernet / data diode) friendly; the in-boundary Registry serves the mirror, **no live crawl**. Recorded as `registry.BundleImported` ([Plan 11](./data-plane.md#plan-11)).
- **In-boundary trust roots + local models, graceful degradation:** Identity issues SVIDs locally; certs use an **internal CA / private ACME** ([ADR-0035](./adr/07-portability-extensibility.md#adr-0035)); secrets via **in-boundary KMS/HSM** ([ADR-0027](./adr/02-identity-security.md#adr-0027)); `embed`/generation pipeline/`"use training"` use **local models when provisioned, else degrade** (generation pipeline→human-authored only, training→static, `embed`→BYO vectors, [ADR-0034](./adr/03-data-plane.md#adr-0034)); telemetry/live-evals stay in-boundary (no phone-home). The **deterministic core (deploy/match/migrate/route) needs no model or egress**, so air-gapped deploys work fully.

| Capability | Normal (connected) | Air-gapped substitute |
|---|---|---|
| Registry (Capability Manifest/plugins/packs) | crawl `/.well-known/capability-manifest/` | **signed offline bundle import** → in-boundary mirror |
| Images | public registry pull | mirrored in-boundary OCI registry (bundle) |
| TLS certs | ACME → Let's Encrypt | **internal CA / private ACME** ([ADR-0035](./adr/07-portability-extensibility.md#adr-0035)) |
| Identity / secrets | provider KMS | already in-boundary; **in-boundary KMS/HSM** ([ADR-0027](./adr/02-identity-security.md#adr-0027)) |
| `embed` / generation pipeline / `"use training"` | hosted models | **local model**, else BYO / human-authored / static |
| Telemetry / live-evals | hosted sinks | **in-boundary OTel collector**, no phone-home |
| Deploy / match / migrate / route | — | **zero egress, no model — always works** |

```mermaid
flowchart TD
  subgraph OUT["outside the boundary"]
    BUNDLE["signed offline bundle<br/>(plugins, Capability Manifest, images, model weights)<br/>+ SLSA provenance + conformance reports"]
  end
  subgraph BND["air-gapped boundary (zero egress)"]
    IMP["hobo registry import<br/>verify signature + provenance + conformance"]
    REG["in-boundary Registry (mirror)"]
    YARD["self-hosted Yard + Identity (SVID) + Executors"]
    CA["internal CA / private ACME"]
    MODEL["local model (embed / generation pipeline / training)<br/>else graceful degrade"]
    APP["deploy / match / migrate / route<br/>(no model, no egress)"]
  end
  BUNDLE -. one-way transfer / data diode .-> IMP
  IMP --> REG
  REG --> YARD
  YARD --> APP
  YARD --> CA
  YARD --> MODEL
```

> Air-gap is a **single in-boundary Yard** that may **stand alone or join a Junction** ([ADR-0036](./adr/07-portability-extensibility.md#adr-0036)); multi-Yard **federation** (multi-region/regulatory/cross-cloud) is designed first-class as the **Junction** ([ADR-0043](./adr/07-portability-extensibility.md#adr-0043), [Q20](./generated-stack.md#historical-open-question-ledger), [Plan 4](./control-plane.md#plan-04) §Yard scope & multi-Yard).

### GitOps publisher mode
Beyond direct apply, a Camp can use a **GitOps publisher** (`@hobo/cd-gitops`, a `publisher`-mode reconciler): it renders the resolved **Deployment Set** as an Argo CD `Application` or a Flux `Kustomization`, commits it through the Git host's HTTP API, and treats the Camp as converged **only when the engine's observed status says so**. The resolution/matching/event-sourcing pipeline is unchanged; only the final apply step differs. Argo CD and Flux are optional targets, never required.

### Pipelines (rule-based automation + approval gates)
> **Delivered by HoBo.CD ([ADR-0182](./adr/01-architecture-core.md#adr-0182), D4).** A delivery Pipeline is a graph with
> lineage, not a step runner.

A **Pipeline** is a DAG of nodes, one per Bindle (or per Rail, when policy itself is delivered). Each node names Camps, or a **Placement** over Rail-bound Camp sets for a fleet, and declares:
- **sources:** Freight sources (pull discovery from registries, Git hosts, package registries, HTTP indexes, HoBo CI, HoBo Rails) and/or upstream nodes;
- **availability:** `ONE_OF` or `ALL` upstream Camps qualified (`QUORUM` for placed nodes), plus `required_soak_ms`;
- **auto-promotion:** `DISABLED`, `NEWEST` or `MATCH_UPSTREAM`;
- strategy and stage percents, a `VerificationSpec`, change windows, typed hooks (`RUNBOOK`, `NOTIFY`, `SUITE`) and `approval_required`;
- optionally `preview_ttl_ms`, which makes the node an ephemeral preview environment.

Freight reaches a node only when upstream qualification and soak make it available, or through an audited, expiring approval (a hotfix). Each Camp runs one promotion at a time; newer Freight supersedes older. There is no expression language. Incident-response runbooks remain the SRE sibling of deploy pipelines ([Plan 40](./operators-sre.md#plan-40)) and attach as `RUNBOOK` hooks.

- **Where CI jobs & builds run is cost-routed.** CI is separate from CD: a CI job runs on a **`runner`** provider and a build on a **`build-machine`** ([Plan 4](./control-plane.md#plan-04)), both selected per job by the **Dispatcher** ([ADR-0071](./adr/01-architecture-core.md#adr-0071)) by **effective marginal cost** across **only the registered** providers. The pick is deterministic + recorded (`dispatch.Decided`, [Plan 11](./data-plane.md#plan-11)). CD consumes CI's output as Freight and does not depend on which CI produced it.
- Every promotion, verification and gate is an event (`env.PromoteRequested`, `verification.Completed`, `freight.Qualified`) → replayable, auditable automation.

```ts
// hobo.delivery.ts — applied with `hobo deploy pipeline apply --file hobo.delivery.ts`
export const pipelines = [
  {
    name: "api",
    bindle: "api",
    nodes: [
      { name: "staging", campIds: ["edge/staging"], sources: ["api-ci"], autoPromotion: "AUTO_PROMOTION_NEWEST" },
      { name: "prod", campIds: ["edge/prod"], sources: ["staging"], approvalRequired: true },
    ],
  },
];
```
