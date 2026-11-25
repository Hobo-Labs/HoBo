---
layout: ../../layouts/Docs.astro
title: Core concepts
description: "The HoBo vocabulary: Bindle, App Kits, Camp, Yard, Junction, continuous migration, WIT/WASM ports, the replayable event log, and agent-native identity."
---

# Core concepts

HoBo's metaphor is the itinerant worker who travels light, and the names lean into it — but every term has a precise technical meaning. Here's the whole vocabulary in one sitting.

## The four scopes

Scopes nest by breadth: **`Bindle ⊂ Camp ⊂ Yard ⊂ Junction`**. The bindle is the one thing you must write; the camp is where your app always lives (declare one to pin placement, or let HoBo infer it from the code you've configured); the last two are for apps that go places.

| Scope | What it is |
|---|---|
| **[Bindle](/HoBo/primitives/bindles/)** | The app, packed: services, resources, wiring, policies, and deployment intent. Provider-agnostic by construction — which is what makes it cheap to move. |
| **[Camp](/HoBo/primitives/camps/)** | Environment shape (prod/staging/…) and runtime **requirements**. Does **not** own the Bindle or select the cloud provider. Durable runtime ports (EventStore, Queue, ActorHost, Clock) are provided by the Camp substrate. |
| **[Yard](/HoBo/primitives/yards/)** | **Provider selection point** plus zero or more camps: cross-camp policy, identity, reconciliation, provider-global networking. One yard per provider. |
| **[Junction](/HoBo/primitives/junctions/)** | Where yards meet: cross-yard **federation** for hybrid/multi-cloud. Peer yards, no shared mutable state — the final edge is federation, not containment. |

Multi-region within a provider = several camps under one yard. Multi-cloud = several yards federated into a junction.

## App Kits (inside a Bindle)

Inside a Bindle, resources split into two families:

| Family | What it is | Examples |
|---|---|---|
| **[App Kit](/HoBo/primitives/app-kits/)** | Application surface that hosts entrypoints or interactive runtime behavior | `api`, `web`, `service`, `ui`, `websocket`, `job`, `wasm-component` |
| **Infra Kit** | Port / infrastructure dependency — not an entrypoint host | `kv`, `bucket`, `queue`, `topic`, `secret`, `data`, … |

**[Session Replay](/HoBo/reference/session-replay/)** is default-supplied on every App Kit (not only `web`).

## Continuous migration

The guiding principle behind everything above: **placement is a standing decision, not a historical one.** Because the bindle is provider-agnostic and the camp is just its current address, HoBo's Dispatcher can keep re-planning placement for as long as the app lives — watching price, credits, reliability, and policy. When a better home clears the gates, the move runs through the same plan → gate → converge loop as any deploy. Migration isn't an emergency procedure in HoBo; it's a lifestyle.

- **Policy-gated:** an inferred or migrated placement is approved by policy, not automatically — your platform decides how much wanderlust to allow.
- **Reversible:** every move is a sequence of events; rolling back a migration is replaying the decision, not archaeology.
- **Cost-directed:** the default objective is simple and honest — the cheapest home that meets your standards.

## WIT/WASM ports

The portable contract between app code, runtime ports, and provider adapters is **WIT** (the WebAssembly Component Model's interface language, hosted on wasmCloud by default). App Kits sit above that contract:

- **Ports are WIT interfaces** — storage, messaging, HTTP, identity, and more.
- **Apps are wasm components** (with an OCI-container fallback for anything wasm can't host yet).
- **Providers are capability providers** linked to component imports — deny-by-default: a component reaches a backend only via a link the manifest declared.
- **Any Component-Model language** can author against the same interfaces. TypeScript is the first reference implementation, not a requirement.

That thin, typed port contract is what makes continuous migration economical: moving homes means re-linking ports to a new provider's adapters, not rewriting the app. App Kits *compose* those ports into Bindle-declared surfaces you author day to day.

## Ports and adapters, everywhere

Cloud providers, IaC engines (Pulumi, Crossplane, Terraform/OpenTofu), build/VM tools (Dagger, Packer, Firecracker), identity systems, and AI optimizers all sit behind replaceable ports. Two consequences:

- **Conformance is the contract.** Every port ships a contract test suite; any adapter — human- or AI-written — must pass it to be certified as a valid home.
- **Patchable, not just portable.** You can swap any engine, add any adapter, fork the Yard, and persist AI/human patches, with conformance as the trust bridge.

## The replayable event log

Control-plane state, projections, SRE workflows, and audit trails all derive from an **append-only event log**. Commands mutate state only by appending events (CQRS/event sourcing), which buys:

- **Recovery:** a crash anywhere — mid-deploy, mid-migration — is recovered by replaying the stream.
- **Audit:** every state transition, including *agent token issuance* and *every migration decision*, is a durable, attributable fact.
- **Time travel:** projections can be rebuilt at any point in history. "Where did this app live in March, and why did it move?" is a query, not a forensic investigation.

The default durable Camp EventStore is **SQLite behind ports** (one partition, one active writer; scale by partitions). Actors append under optimistic sequence **and** a fencing token so a stale holder cannot win after lease transfer. Catch-up projections use database-local positions; live callbacks are an optimization, not the only delivery path. Queue/timer/outbox side effects can stage in the **same** durable transaction as domain facts, while network dispatch happens outside that transaction.

## Contract effects (what a boundary can do)

Contracts are not only request/response shapes. A boundary can declare an **EffectSpec**: purity (pure vs varies vs transacts…), capability tags (may fail, may suspend…), and domain I/O (network, storage, identity, policy eval, agent tools…). Pure contracts isolate for unit tests with zero infrastructure; domain effects drive automatic harness mocks. When a revision **widens** effects (for example pure → network), can-deploy treats that as a potential breaking change for consumers that assumed a narrower set.

## Visible resiliency (secondary layer)

Operations that face flaky I/O may carry a **ResilienceProfile** — deterministic retry schedules, timeouts, circuit-breakers, and related strategies — as **contract-visible metadata**, not a new top-level control-plane noun. Application emits attempt/terminal facts for replay. Hard rules stay fixed: `policy.Decided` denials and typed terminal failures **never** retry; cancellation stops pending work; inspection is reconstructed from the event log, never process memory.

## Agent-native identity

AI agents are **first-class principals**, not scripts holding a human's API key:

- Workload identity (SVID/OIDC) with **brokered short-lived tokens** — secretless-first, no static credentials.
- A machine-readable **capability standard** so agents can self-provision exactly the credentials a task needs.
- Policy checks at every phase, and traceable actions in the same event log as everything else.
- An MCP control surface alongside the SDK and CLI, so the same capabilities are reachable by humans and agents alike.

## Where the details live

- [Bindles](/HoBo/primitives/bindles/) · [App Kits](/HoBo/primitives/app-kits/) · [Camps](/HoBo/primitives/camps/) · [Yards](/HoBo/primitives/yards/) · [Junctions](/HoBo/primitives/junctions/) — the primitive references.
- [Session Replay](/HoBo/reference/session-replay/) — default on every App Kit.
- [Architecture](/HoBo/architecture/) — the machinery that does the describing, placing, and moving.
- [HoBo for agents](/HoBo/agents/) — the agent identity model and MCP surface.
