---
type: Reference
title: "Reference Architecture & Monorepo"
description: "This capability doc covers the reference architecture and, beneath it, the monorepo & package layout that realizes it."
tags: [hobo, design]
---

# Reference Architecture & Monorepo

This capability doc covers the reference architecture and, beneath it, the monorepo & package layout that realizes it.

## Plan 10

> **Resource Definitions & Matching (Humanitec parity):** the Planner box resolves resources via **Resource Definitions + Matching** ([Plan 25](./platform-engineering.md#plan-25)); Executors can run behind a **HoBo Relay** inside a private network ([Plan 25](./platform-engineering.md#plan-25)); a **GitOps publisher** is an alternate path from Set → cluster.

> **Contracts & policy (gates):** two governance planes sit at the deploy decision point as **WIT ports with built-in engines** — a **contract plane** (compatibility/`can-deploy`, [Plan 29](./contracts-policy-flags.md#plan-29)) and a **policy plane** (decisions + obligations, [Plan 29](./contracts-policy-flags.md#plan-29)) — composed by the **Gatekeeper** alongside conformance/evals/cost. The organizing lens across the suite: **Contract = must never break · Eval = should improve · Policy = may/may not be allowed · Trace = what actually happened.**

> **Runtime/IfC integration.** Deployed services are **wasm components** (OCI-container fallback) running on a wasm host that links each component's imported WIT ports to **capability providers** ([Plan 20](./wasm-runtime-wit.md#plan-20)). The deploy path has a **resource-collection (IfC)** step that emits the **manifest IR** the Planner consumes ([Plan 21](./authoring-resources-wiring.md#plan-21)).

> **Data plane + the Operator Crew.** App **domain data is event-sourced by default** — the "Read models" box generalizes to developer-authored **projections** the architect maps onto any backend (a **projection sink**, [Plan 32](./data-plane.md#plan-32)). A roster of built-in **Operator Agents (the Crew)** runs inside the Yard — SRE · Endpoint Monitor · GitOps · Platform Engineer ([Plan 40](./operators-sre.md#plan-40)) — each a principal on the same identity/policy/event model; the **SRE operator** drives **incidents + self-healing** ([Plan 40](./operators-sre.md#plan-40)). HoBo **generates / self-heals / persists the app across data · business · message · intelligence · UI** ([Plan 23](./generated-stack.md#plan-23)) — AI-generated adapters + self-optimizing runtime functions + design.md-driven UI ([ADR-0056](./adr/03-data-plane.md#adr-0056)). Beyond portability, every box is **patchable** — engines/adapters swap behind ports, certified by conformance ([Plan 23](./generated-stack.md#plan-23)).

### The one-paragraph model
A developer (or agent) writes a **Bindle** (app topology, [Plan 2](./sdk-api.md#plan-02)) and **`camp()`/`yard()` scope objects** ([Plan 4](./control-plane.md#plan-04)). The **Yard** ([Plan 4](./control-plane.md#plan-04)) — HoBo's **provider-specific** control plane, **one per provider**, which **owns provider selection** ([yard-first-placement ADR](./adr/yard-first-placement.md)) — receives a deploy request, the **Planner** turns the Bindle + Yard-derived mapping into a **DeploymentPlan** (a DAG of `ResourcePlan`s), and the **Orchestrator** drives each resource to reality through **ResourceActors** that call **IaC/Build adapters** inside sandboxed **Executors**, brokering short-lived credentials from **Identity**. Every state transition is an **event** ([Plan 11](./data-plane.md#plan-11)) in an append-only log, so the whole system is replayable, auditable, and recoverable. The app deploys into a **Camp** — a **provider-neutral deployment target until attached to a Yard** that **infers** provider/runtime/IaC from its Yard (or from Yard placement policy when inferred) and supplies the **durable runtime** ([Plan 2 §Layer 1](./sdk-api.md#plan-02)): event store, queue, streams, actor host, and clock. Camps **do not select the cloud provider**; the **Yard authors the provider**, and Camps can **move between Yards via Trails**. The scopes nest by **breadth** as **`Bindle ⊂ Camp ⊂ Yard ⊂ Junction`** ([ADR-0026](./adr/01-architecture-core.md#adr-0026)) — but the final edge is **federation, not containment**: `⊂` is true *containment/ownership* for `Bindle ⊂ Camp ⊂ Yard` (a Yard owns its Camps' control plane), whereas a **Junction *federates* peer Yards** ([ADR-0043](./adr/07-portability-extensibility.md#adr-0043)) — it holds no shared mutable state and is not a parent controller over the Yards, so "Yard ⊂ Junction" denotes *scope breadth* (the Junction is the broadest scope), not a containing aggregate. Multi-region within a provider = several Camps under one Yard; multi-cloud = several Yards **federated into** a **Junction** (the cross-cloud / hybrid scope).

### Control plane vs data plane
HoBo has two distinct planes; keeping them separate is a core architectural commitment.

- **Control plane (the Yard).** Decides *what infra should exist* and makes it exist. Event-sourced, actor-based, multi-tenant. It is **provider-specific** — one Yard per provider, governing that provider's **Camps** and holding cross-Camp policy + provider-global networking/gateways. Cross-cloud / hybrid topology is the **Junction** connecting Yards, not the Yard itself ([ADR-0026](./adr/01-architecture-core.md#adr-0026)). Never on the critical path of a running app's request. If the Yard is down, deployed apps keep serving.
- **Data plane (the running Bindle).** The developer's actual app + the **Camp's durable runtime**. Uses HoBo's runtime SDK primitives (actors, workflows, sagas, agents) but does not depend on the Yard at request time. The runtime it runs against is **supplied by the Camp after the Camp attaches to (or is inferred under) a Yard** — the Yard owns the provider; the Camp's runtime backend is selected under that Yard (and can be fully self-managed).

```mermaid
flowchart LR
  subgraph Dev["Developer / Agent"]
    SDK["@hobo/bindles + @hobo/runtime"]
    CLI["@hobo/cli"]
    MCP["MCP client (Claude, etc.)"]
  end

  subgraph Yard["The Yard (control plane)"]
    GW["Gateway<br/>(RPC / REST / MCP)"]
    ID["Identity<br/>(SVID, OIDC, token broker)"]
    REG["Registry<br/>(Provider + Capability Manifest)"]
    PL["Planner<br/>(Bindle -> DeploymentPlan DAG)"]
    OR["Orchestrator<br/>(ResourceActors + sagas)"]
    EX["Executors<br/>(sandboxed IaC/Build)"]
    ES[("Event Store<br/>source of truth")]
    RM[("Read models<br/>projections")]
  end

  subgraph Cloud["Real providers"]
    CLOUDS["AWS / Azure / GCP / CF / Fly / K8s"]
  end

  subgraph Data["Data plane (deployed Bindle, in a Camp)"]
    APP["App code<br/>(actors / workflows / sagas / agents)"]
    RT["Camp runtime<br/>(events/queue/streams/actors/clock)"]
  end

  CLI & SDK & MCP --> GW
  GW --> ES
  PL --> ES
  OR --> ES
  OR --> EX
  EX --> CLOUDS
  ID -. brokers tokens .-> EX
  REG -. capabilities/auth .-> PL
  ES --> RM
  RM --> GW
  CLOUDS --> APP
  APP --> RT
```

### Component responsibilities (C4 "container" level)

> **Disambiguation** ([glossary](./glossary.md)): this table uses "component"
> in the **C4 sense** — control-plane *modules*. The glossary's canonical
> **Component** is the WASM/WASI deployable unit (manifest `component.v1`);
> Dapr "components" are a third, adapter-local sense confined to
> `runtime-dapr`. The taxonomy below (§Key boundaries) lists all three.

| Component | Responsibility | Key inputs | Key outputs (events) |
|---|---|---|---|
| **Gateway** | Authn/z; expose SDK RPC + REST + MCP; accept commands; serve read models | Commands, identity tokens | `DeployRequested`, `BindleRegistered`, … |
| **Identity** | Issue workload identities (SVIDs); act as OIDC IdP; broker provider tokens via Capability Manifest | SVID requests, provider Capability Manifest | `IdentityIssued`, `TokenGranted`, `TokenRevoked` |
| **Registry** | Catalog providers + their Capability Manifest (capabilities, auth, cost) | Provider manifests | `ProviderRegistered`, `CapabilityManifestUpdated` |
| **Planner** | Resolve mapping rules → `DeploymentPlan` DAG; solve capability/region/cost constraints | Bindle, config, Registry | `Planned`, `PlanRejected` |
| **Orchestrator** | Drive the plan; one **ResourceActor** per resource reconciling desired↔actual; choreography sagas for cross-resource ordering & compensation | `DeploymentPlan`, observed state | `Provisioning`, `Provisioned`, `Failed`, `Compensating`, `Deployed` |
| **Executors** | Run IaC apply/preview/destroy + image/VM builds in Firecracker sandboxes with scoped creds | `IacProgram`, `BuildSpec`, brokered token | `ExecStarted`, `ExecOutput`, `ExecSucceeded`, `ExecFailed` |
| **Event Store** | Append-only source of truth; subscriptions; snapshots | Events | (is the log) |
| **Read models** | Materialized projections for queries/UI | Event stream | (query API) |

### Request lifecycles (two canonical paths)
**Deploy (command path):**
`hobo up` → Gateway authenticates the principal → emits `DeployRequested` → Planner consumes it, emits `Planned` → Orchestrator spawns ResourceActors → each emits `Provisioning`→`Provisioned` (or `Failed`→`Compensating`) → on DAG completion, `Deployed`. A crash anywhere is recovered by replaying the deployment's event stream.

**Run inspection (query path):**
`hobo inspect run <id>` / dashboard → Gateway → read model projection of the run's events (workflow/step/actor/saga timeline). Never touches the providers.

### Key boundaries & invariants

**Component & boundary taxonomy.** "Component" and "boundary" each carry
several precise senses; this table is the canonical disambiguation
([ADR-0145](./adr/01-architecture-core.md#adr-0145) covers the companion
Trait concept):

| Sense | What it bounds / names | Typed as | Enforced by |
|---|---|---|---|
| **Component (WASM)** | The deployable unit | `ComponentDescriptor`/`LinkRecord` (`packages/core/src/ports/component-host.ts`), manifest `component.v1` | component-host conformance suite; WIT lock |
| **Component (C4 module)** | Control-plane responsibility areas (table above) | prose | package layering rules |
| **Component (Dapr)** | Dapr building-block bindings | adapter-local (`runtime-dapr`) | adapter tests |
| **BoundaryContract** | Any of 13 integration edge kinds (http, event, resource-binding, agent-tool, …) with effects + resilience | `packages/contracts/src/contract-ir.ts` (`hobo.contract-ir/v1`, content-hashed) | `can-deploy` / Gatekeeper (ADR-0136) |
| **Membrane (WIT/wRPC)** | The polyglot call boundary between components and providers | `LinkRecord.boundaryMode`/transport; link table + wRPC layer | runtime link enforcement; manifest-declared links only |
| **Integration boundary (PACT)** | Consumer↔provider expectations across packages | `contracts/*.pact.json` + `*-boundaries.test.ts` | standards gate + `architecture:guard` |
| **Parse boundary** | Untrusted input → derived domain types | per-package parsers | technical-standards.md ("one parser boundary") |
| **Consistency boundary** | The write model (Aggregate) | stream + `expectedSeq`/fencing | DurableEventStore CAS (ADR-0135) |
| **Capability boundary** | What a component may call, from inferred usage | grants (`packages/core/src/capability/`) | capability-enforcement conformance suite |
| **Isolation boundary (Station)** | Control-plane isolation: tenant, residency, air-gap, trust domain | `StationIsolation` proto | Station/Rail policy pins |
| **Tenancy boundary** | Pooled = logical, siloed = physical | app-tenant stream prefix + platform filter | cross-tenant-leak conformance gate (ADR-0080) |
| **Trust/air-gap boundary** | Zero-egress sovereign Yards; in-boundary trust roots | ADR-0036 profile | offline bundle verification; egress denial |

Invariants:
1. **Commands mutate only via events.** No component writes resource state except by appending an event (CQRS/ES). This is what makes everything replayable — and it **includes ephemeral runtime-instance patches**: an agent's in-place patch isn't promoted to *source control*, but its full diff is captured as a durable `derivative.EphemeralPatchApplied` event ([ADR-0057](./adr/07-portability-extensibility.md#adr-0057)), so replaying the log still reconstructs the patched instance. "Not in source" never means "not in the replayable log."
2. **Executors are the only thing that touches a cloud**, always sandboxed, always with a short-lived scoped token (never a long-lived secret). See [Plan 12](./security-networking.md#plan-12).
3. **The Yard is itself a Bindle** deployed by an earlier Yard (or bootstrapped locally) — see [Plan 4 §Bootstrapping](./control-plane.md#plan-04).
4. **Same code, many Camps.** Swapping a Camp's **Yard attachment** (or its runtime backend under that Yard) changes where/how it runs, never app logic. See [Plan 2 §Layer 1](./sdk-api.md#plan-02) and [yard-first-placement](./adr/yard-first-placement.md).

### Runtime/IfC components (integrated)
Two more boxes on the map:
| Component | Responsibility | Key events |
|---|---|---|
| **Wasm host** (per provider target) | run service **components**; hold the **link table** binding each import → a capability provider ([Plan 20](./wasm-runtime-wit.md#plan-20)) | `link.Established`, `link.Called` |
| **Collector** (IfC) | run components in resource-collection mode → the **manifest IR** the Planner consumes ([Plan 21](./authoring-resources-wiring.md#plan-21)/[Plan 21](./authoring-resources-wiring.md#plan-21)) | `bindle.ResourcesCollected`, `bindle.ManifestProduced` |

**Invariant addendum.** A deployed component reaches a backend **only via a link the manifest declared** — deny-by-default capability security extends invariant #2 from the executor to the running data plane ([Plan 12](./security-networking.md#plan-12)).

### Monorepo & package architecture
The architecture above is realized as a layered monorepo. **Tooling (current):** pnpm workspaces + Turborepo (strict env, honest task graph, single root TypeScript via `tsc` builds); Vitest for `packages/*`; Biome for `packages/*` lint. **Tooling (target):** `tsup`/`unbuild` bundled builds, Vitest and Biome repo-wide, and Changesets for versioned publishing land as packages become publishable.

#### Layering & dependency rule
Packages are layered; dependencies point **inward only** (`apps → adapters → sdk/runtime → core`). `@hobo/core` depends on nothing HoBo. This keeps adapters swappable and prevents the agnostic core from leaking provider details.
```
core  ←  sdk, runtime  ←  runtimes/*, providers/*, iac/*, build/*  ←  cli, cloud, mcp, registry, identity
                          (all adapters depend only on core's port interfaces)
```

#### Packages

> **Target layout.** Entries marked ✱ are designed but not yet packages on disk; the authoritative on-disk list is `packages/` itself (see also [`package-namespaces.md`](./package-namespaces.md) and [`live-provider-matrix.md`](./live-provider-matrix.md)).

```
packages/
  core/            @hobo/core         types, port interfaces (incl. jurisdiction/residency, offering-resolution, traffic-routing + data-store offerings), Capability Manifest schema, event envelope, DI/container
  wit/             @hobo/wit          WIT interfaces (wasi:* reuse + hobo:* ports) + the canonical hobo:sdk WIT package + wit-bindgen/jco bindings (per language)  [Plan 20/ADR-0072]
  bindles/         @hobo/bindles      app idiom layer (TS) over the hobo:sdk bindings: IfC resources (api/web/kv/bucket/queue/topic/secret≈vault/sql/...) + .allow(); bindle() (advanced) — semantics-free, conformance-gated  [Plan 21/ADR-0072]
  camps/           @hobo/camps        camp() — provider-neutral deployment target; provider inferred from Yard attachment
  yards/           @hobo/yards        yard() + domain() — provider-specific control-plane scope (**owns provider selection**)
  junctions/       @hobo/junctions    junction() — cross-cloud federation + inferred connectivity  [ADR-0043]
  bindles-rs/py/go ✱ ... per-language app idiom layers over the same hobo:sdk bindings (hand-authored or SWE-operator-generated; gated by @hobo/conformance/sdk)  [ADR-0072]
  runtime/         @hobo/runtime      actors/grains, workflow/step, agent(), stubs, ctx
  data/            @hobo/data         command/view/projection CQRS authoring helpers (fenceToken on aggregate append — ADR-0135)
  events/          @hobo/events       emit/subscribe/saga messaging and choreography helpers + upcaster registry & golden-replay corpus gate
  contracts/       @hobo/contracts    Contract IR + can-deploy + Gatekeeper; optional EffectSpec + ResilienceProfile (ADR-0136)
  contract-harness/@hobo/contract-harness  PACT harness + effect-aware isolation/mocks/fault injection (ADR-0136)
  storage-sqlite/  @hobo/storage-sqlite  SQLite schema/migrations/journal semantics behind ports (ADR-0135; not the public boundary)
  stations/        @hobo/stations     Station occupancy + Rails + local client + PAM hooks (ADR-0131) + traffic-routing control loop, progressive cutover saga, offering registry (ADR-0143)
  trails/          @hobo/trails       continuous migration recipes + can-trail (ADR-0134) + live migration executor, tenant-move/schema-apply/data-dual ports, upgrade preflight evidence
  connectivity/    @hobo/connectivity naming consumers, overlay, DNS, secretless connectors, env isolation, metering sinks (ADR-0130+) + TrafficRouting adapters (cloudflare · vercel · lakebed · funnel · simple, ADR-0143)
  broker/          @hobo/broker       pure Conductor: policy-governed placement receipts (mounts Station client) + budget signal plane (`budget.ThresholdCrossed`/`Recovered`)
  dispatcher/      @hobo/dispatcher   ADR-0071 Dispatcher: credit/budget-aware deterministic selection (placement · runner/build-machine dispatch · traffic backends); reservation CAS + hysteresis; `dispatch.Decided`/`dispatch.Reservation*`
  cloud/           @hobo/cloud        Planner/Matching + continuous-delivery apply plane (workload-attested)
  replay/          @hobo/replay       Session Replay on every App Kit (privacy-first; `replay.*`; ADR-0137 — distinct from event-log replay; App Kit ≠ WIT membrane)
  componentize/    @hobo/componentize component build via jco + per-language toolchains -> OCI artifacts  [Plan 20]
  cli/             @hobo/cli          hobo up|down|dev|new|login|claim|plan|verify|can-deploy|inspect|logs|doctor|codegen|build|collect|stub|drift|add|registry|import|generate|sandbox|test|attest|erase|derivative|runbook|station|trails|feature|identity|connection|broker|replay
  runtimes/          (Camp durable engines + component hosts)
    runtime-local      @hobo/runtime-local     (built-in EventStore engine; node:sqlite + storage worker — ADR-0135)
    runtime-browser    @hobo/runtime-browser   (SQLite WASM + OPFS policy; fail-closed without OPFS — ADR-0135)
    runtime-wasm       @hobo/runtime-wasm      (Wasmtime OS-process sandboxes; componentHost=wasm)
    runtime-oci        @hobo/runtime-oci       (WASM-on-OCI → Kubernetes via KubectlTransport PACT)
    runtime-cloud-native @hobo/runtime-cloud-native (multi-cloud host registry; mock + provider stubs)
    runtime-postgres   @hobo/runtime-postgres  (design / later)
    runtime-temporal   @hobo/runtime-temporal  (design / later)
    runtime-restate    @hobo/runtime-restate   (design / later)
    runtime-rivet      @hobo/runtime-rivet      (preferred compatible ActorHost resolver — actor-local journal + inbox; CJS hosts must dynamic-import rivetkit)
    runtime-celld      @hobo/runtime-celld      (experimental Durable Objects dialect; overlay + CAS bucket; not Component Model WASM; live binary missing = fail)
    runtime-cloudflare @hobo/runtime-cloudflare  (Durable Objects — design / later)
  providers/
    provider-aws       @hobo/provider-aws
    provider-azure     @hobo/provider-azure
    provider-gcp       @hobo/provider-gcp
    provider-digitalocean @hobo/provider-digitalocean
    provider-hetzner     @hobo/provider-hetzner  (VMs/networking/storage only — no managed data services)
    provider-hostinger   @hobo/provider-hostinger (adopt-and-converge: allocation is a billing order)
    provider-flux        @hobo/provider-flux     (Orbit = git mode; OCI digest production; not an actor runtime)
    provider-cloudflare  @hobo/provider-cloudflare
    provider-convex      @hobo/provider-convex   (Convex deploy-target CloudProvider — thin SaaS adapter w/ typed impedance, ADR-0144)
    provider-lakebed     @hobo/provider-lakebed  (deploy-driver style, ADR-0127)
    provider-kafka / provider-ax / provider-agentv / provider-config
    runner-github / runner-blacksmith / runner-depot   (Dispatcher runner/build-machine candidates)
    provider-fly ✱
    provider-kubernetes  @hobo/provider-kubernetes (built-in objects + placement driver)
  iac/
    iac-pulumi         @hobo/iac-pulumi        (Automation API — first-party adapter; not sole primary)
    iac-terraform      @hobo/iac-terraform     (terraform/tofu CLI engine)
    iac-crossplane     @hobo/iac-crossplane
    iac-cdktf / iac-opentofu ✱
    iac-nix ✱          @hobo/iac-nix           (optional — Nix flakes / NixOS; never default multi-cloud IaC)
  build/ ✱
    build-wasm         @hobo/build-wasm        (jco/cargo-component/TinyGo/... -> wasm component, OCI artifact)
    build-dagger       @hobo/build-dagger      (container fallback images)
    build-packer / build-firecracker / build-vagrant
  sdk/ ✱             @hobo/sdk          operator SDK — configure & self-host a HoBo cloud: the Yard (control plane), itself a Bindle; defineResource + policy/waiver + dispatcher + runbooks; hosts the built-in Operator Agents (the Crew)  [Plan 40]
  registry/ ✱        @hobo/registry     Provider/Capability Manifest catalog service
  identity/          @hobo/identity     SVID issuance, OIDC provider, token broker
  mcp/               @hobo/mcp          MCP server exposing HoBo to agents
  agent-skills/ ✱    @hobo/agent-skills skills the Operator Agents (the Crew) + external MCP agents compose          [Plan 40]
  hobo-code/ ✱       @hobo/hobo-code    the Hobo Code DSL — token-efficient IR for codegen + platform config         [Plan 21]
  conformance/       @hobo/conformance  port contract test suites (shared by all adapters)
  contracts/         @hobo/contracts    HoBo Contract IR + compatibility/can-deploy engine (built-in)  [Plan 29]
  policy/            @hobo/policy        policy decision model + built-in TypeScript engine + residency policy pack + control→evidence packs (ADR-0146)  [Plan 29]
  evals/ ✱           @hobo/evals         rubrics + promotion gates for semantic functions             [Plan 23]
  fuzz/              @hobo/fuzz          property oracles + serialized-input harnesses (simulators only)
  training/ ✱        @hobo/training      training-engine port + built-in OPTO optimizer + OpenInference capture (INTERNAL; not on the SDK surface)  [Plan 23]
    provider-pact ✱           @hobo/provider-pact             (optional) Pact/Broker adapter behind contract-engine
    provider-opa ✱            @hobo/provider-opa              (optional) OPA/Rego adapter behind policy-engine
    provider-cedar ✱          @hobo/provider-cedar            (optional) Cedar adapter behind policy-engine
    provider-agent-lightning ✱ @hobo/provider-agent-lightning (optional, INTERNAL) Microsoft Agent Lightning behind training-engine
    provider-trace ✱          @hobo/provider-trace            (optional, INTERNAL) Microsoft Trace (OPTO) behind training-engine
examples/
  hello-bindle/ ci-runner-balancing/ multi-cloud-shop/ durable-agent/ self-host-yard/
```

#### Projects (top-level surfaces → packages)
The product's named **Projects** map to packages here: **Cloud / self-host** → `@hobo/sdk` (the operator SDK, + `registry`/`identity`); **App SDK** → `@hobo/bindles` (+ `runtime`); **topology** → `@hobo/camps`/`@hobo/yards`/`@hobo/junctions`; **CLI** → `@hobo/cli`; **MCP** → `@hobo/mcp`; **agent-skills** → `@hobo/agent-skills`; **DSL** → `@hobo/hobo-code` (the token-efficient IR for codegen + platform config, [Plan 21](./authoring-resources-wiring.md#plan-21)); **App/UI generation** → `@hobo/ui-render` (UX Designer operator + `ui-render` port — in scope per [ADR-0064](./adr/07-portability-extensibility.md#adr-0064)/[ADR-0056](./adr/03-data-plane.md#adr-0056)).

#### Conventions
- **Ports live in `core`**, implementations in adapter packages; adapters never import each other.
- **Every adapter runs `@hobo/conformance`** for the ports it claims, in CI ([Plan 9](./generated-stack.md#plan-09)).
- **Examples are tests** — `examples/*` double as E2E fixtures.
- **Public type surface is the contract** — provider option types are exported for `.with(...)` autocomplete ([Plan 2](./sdk-api.md#plan-02)).
