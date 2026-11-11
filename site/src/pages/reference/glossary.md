---
layout: ../../layouts/Docs.astro
title: Glossary
description: "Site-facing definitions for HoBo primitives, ports, contracts, effects, Crew, identity, and delivery terms."
---

# Glossary

| Term | Definition |
|---|---|
| **Bindle** | Provider-agnostic packed app: services, resources, wiring, policy intent |
| **Camp** | Environment shape + runtime requirements; current home address (not provider selection) |
| **Yard** | Provider selection point + camps; control-plane scope (policy, identity, reconciliation) |
| **Junction** | Cross-yard federation; peer yards, no shared mutable state |
| **Conductor / Broker** | Policy-governed placement authority (Conductor) |
| **Station** | Hard control-plane isolation boundary a Conductor occupies |
| **Rail** | Content-addressed Station profile/bootstrap pin |
| **Trail** | App-owned continuous migration recipe |
| **OpenFeature** | CNCF flag evaluation API; sole public app flag surface under Harness |
| **Matching** | Resource definition + placement selection process |
| **ResourceActor** | Single-writer reconcilers for infrastructure resources |
| **Gatekeeper** | Composite deploy gate: contracts + policy + obligations + cost (+ more) |
| **Contract IR** | Versioned `BoundaryContract` between producer and consumer edges |
| **EffectSpec** | Optional side-effect annotation (purity + domains) on a contract |
| **EffectManifest** | Exportable summary of a contract’s effects |
| **ResilienceProfile** | Secondary resiliency metadata (retry/timeout/…); not a primary noun |
| **EventStore** | Append-only log port for domain/control facts |
| **DurableEventStore** | EventStore + positions, commit-with-effects, durable checkpoints |
| **EventPosition** | Partition-local monotonic store position (`bigint`) |
| **SQLite partition** | One DB file, one active writer; scale by partitions |
| **ActorHost** | Single-writer lease + fencing token for aggregates |
| **fenceToken** | Monotonic lease epoch (`bigint`) paired with stream `owner_epoch` |
| **Streamer** | High-volume frame journal outside the domain event log |
| **Queue** | Deferred work port with leases and idempotency |
| **Clock** | Deterministic time port for workflows and tests |
| **Crew** | Built-in operator agents in the Yard |
| **A2H** | Agent-to-human handoff with obligation deadlines |
| **Runbook** | Trigger → diagnose → gated fix, event-sourced |
| **PACT** | Consumer-driven interaction tests under Contract IR |
| **Bridge** | Session-scoped local/remote boundary routing modes |
| **Harness** | Flags / progressive delivery / experiments plane |
| **Lane** | Sandbox isolation for experimental traffic/contracts |
| **Golden suite** | Signed multi-check deploy gate bundle |
| **SVID** | Workload/agent SPIFFE-style identity document |
| **Relay** | Outbound network proxy keeping cloud creds in-boundary — *not* an agent |
| **Named endpoint** | Hierarchical DNS-valid host under `.hobo.localhost` / `.hobo.test` |
| **Resource intent** | Provider-neutral desired resource used in planning/FinOps routing |
| **Showback** | Usage attribution projection — not an invoice by itself |
| **Secretless-first** | Prefer federation/bindings over stored secrets |
| **can-deploy** | Compatibility matrix diagnostic for producer/consumer skew |
| **can-trail** | Gate dimension for Trail readiness |
| **WIT** | Wasm Interface Types — portability contract for capabilities (wRPC) |
| **App Kit (Kit)** | Bindle-declared application surface (`api`, `web`, `service`, `ui`, `websocket`, `job`, `wasm-component`). Session Replay default-on. |
| **Infra Kit** | Bindle port/infra resource (`kv`, `bucket`, `queue`, …) — not an entrypoint host; no default Session Replay |
| **Session Replay** | Privacy-first DOM/session reconstruction on every App Kit (Session Replay, ); `replay.*` — not event-log replay |
| **Messaging** | Backend-agnostic publish/subscribe over the messaging port / `topic()` with delivery guarantees, consumer groups, DLQ |
| **Kafka capability provider** | Kafka provider exporting the messaging port for Kafka-compatible brokers; secretless bindings |
| **Dapr runtime adapter** | Optional optional Dapr runtime Camp runtime realizing ActorHost + pubsub; never the default |
| **Event-log replay** | Folding durable EventStore facts for projections/audit — different from Session Replay |
| **HoBo CI** | Runs GitHub Actions jobs on capacity you choose: one runner label, admission against the budget policy |
| **Relay (CI)** | The HoBo CI service that receives GitHub's job events and admits jobs |
| **Fleet (CI)** | Every runner provider one account has connected, ranked per job by cost |
| **Route table (CI)** | Published map of job class → runner label, so a job can ask for a label provider before it is queued |

Longer design glossary lives in the repo design suite; this page is the **site-facing** subset for humans and agents reading Pages.
