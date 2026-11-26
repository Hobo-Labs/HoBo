---
type: Competitive Reference
title: "Rivet — competitor reference"
description: "Rivet actors as the preferred compatible ActorHost resolver — not a topology primitive and not an app authoring model."
tags: [hobo, competitors]
competitor:
  slug: rivet
  name: "Rivet"
  aliases: ["rivetkit"]
  primary_category: runtime-substrates
  categories: [runtime-substrates]
  directness: adjacent
  role: "open-source Durable Objects / actor runtime — preferred compatible ActorHost resolver"
  posture: [adopt, provider-target]
  hobo_surface: [runtime-portability, replay-migration]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://rivet.dev/docs/actors/
    - https://github.com/rivet-dev/rivet
---

# Rivet

**Checked:** 2026-08-13  
**Sources:** [rivet.dev/docs](https://rivet.dev/docs/actors/), [Queues](https://rivet.dev/docs/actors/queues/), [GitHub rivet-dev/actors](https://github.com/rivet-dev/actors)  
**License:** Apache-2.0  
**Role in HoBo:** preferred compatible **ActorHost resolver**, not a topology primitive and not an app authoring model.

## What it is

Open-source actor runtime (RivetKit + optional self-hosted engine). Each actor can own co-located SQLite (`c.db`). Local/in-process mode needs no control plane. Runner mode connects workers outbound to a control plane.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Actor** | The unit: an addressable, single-threaded object with durable state |
| **`c.state`** | A mutable durable blob attached to the actor |
| **`c.db`** | Co-located SQLite owned by that actor |
| **Queue** | Per-actor message delivery |
| **Namespace / pool** | Deployment and isolation grouping |
| **RivetKit** | The library; the engine is optional and self-hostable |
| **Runner mode** | Workers connecting outbound to a control plane |

The mental model is **Durable Objects, open source**: address an actor by key, get single-threaded
execution and durable state co-located with the code, with no control plane required for local or
in-process use.

## How it competes with HoBo

Rivet is **adopted, not contested**: it is the preferred compatible **ActorHost resolver**, not a
topology primitive and not an application authoring model. The overlap is `runtime-portability` and
`replay-migration`, and in both cases HoBo is the consumer.

The section below is the substance of this capture, and it is deliberately adversarial about the
adapter boundary — the details that decide whether a resolver is safe to depend on.

## Impedance boundaries (do not over-claim)

| Rivet fact | HoBo consequence |
|---|---|
| Queue message is removed on **receive**, not on `complete()` | HoBo `hobo_inbox` is command authority (`kv.durable-object.durable-inbox/v1`) |
| `wait: true` between actors deadlocks on self-send | Forbidden in the adapter |
| `c.state` is mutable durable blob | Not the event-sourced journal; facts live in `hobo_events` |
| Namespace / pool | Camp/Yard resolver artifacts, not Bindle fields |
| Postgres self-host ~1k concurrent actors (docs) | Evidence class, not a HoBo guarantee |
| FoundationDB / managed cloud | Optional; unsupported until verified |
| WASM vs native SDK | Distinct from HoBo Component Model / WIT |
| Published `rivetkit` 2.3.10 `.cjs` uses `import.meta` | `require("rivetkit")` is broken; adapters use dynamic `import()` (`loadRivetkit`) |

## Feature surface

- Actor addressing, lifecycle and single-threaded execution.
- Durable `c.state` blob plus per-actor SQLite (`c.db`).
- Queues for actor-directed messages.
- Local/in-process mode with no control plane; runner mode with outbound worker connections.
- Namespaces and pools for grouping.
- Apache-2.0 licence, self-hostable engine.

## Architecture

- **Actor placement** — keyed addressing resolved by the engine; in local mode there is no engine at
  all, which is what makes it usable for development.
- **Durability** — per-actor SQLite co-located with execution, so state access is local rather than
  networked. This is the property that makes the model attractive.
- **Connectivity** — runner mode has workers connect **outbound** to the control plane, the same
  no-ingress posture Harness and Qovery use.
- **State authority** — the actor's own `c.state` and `c.db`. Crucially for HoBo, this is a mutable
  store, not an event journal, which is why HoBo keeps facts in `hobo_events` rather than trusting
  actor state as the record.
- **Portability boundary** — the actor API is Rivet's; the SQLite schema underneath is ordinary. HoBo
  exports Trails logically rather than copying SQLite files, precisely so the boundary stays at the
  data rather than the storage engine.

## Primitive mapping

| HoBo | Rivet |
|---|---|
| `actor()` / Grain | Generated internal Rivet definition + compound key `["hobo", tenant, project, type, ...]` |
| EventStore (global) | Outbox → existing Camp EventStore |
| Actor-local journal | `c.db` / node:sqlite with HoBo schema |
| Trails | Logical export, not physical SQLite copy |
| Celld / Cloudflare DO | Sibling resolvers; not this package |

Marketing latency/scale numbers are **not** HoBo guarantees.

## Where Rivet is stronger

- **Actor-local SQLite is the right primitive** for stateful actors, and having it open source and
  self-hostable is rare — the alternative with comparable ergonomics is a proprietary cloud runtime.
- **No control plane needed locally.** In-process mode makes the development loop trivial, which is
  the property most actor runtimes get wrong.
- **Outbound-only runner connectivity** fits enterprise network constraints without special handling.
- **Apache-2.0** with a self-hostable engine, so adoption carries no vendor dependency.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Facts live in an event journal, not in actor state** (*implemented*, ADR-0135). `c.state` is a
  mutable blob; HoBo's `hobo_events` is append-only and replayable, and the adapter is written so
  that Rivet's mutability never becomes HoBo's source of truth.
- **Command authority is HoBo's, not the queue's** (*implemented*). Because a Rivet queue message is
  removed on *receive* rather than on `complete()`, HoBo uses `hobo_inbox` as the command authority
  rather than relying on queue semantics for exactly-once behaviour.
- **Actors are portable across resolvers** (*implemented*): Rivet, celld and local runtimes are
  siblings behind one ActorHost port, so no single runtime's semantics leak into the model.
- **Honest caveat.** Rivet ships a working actor runtime today; HoBo's value here is the port and the
  impedance discipline around it, not a better actor implementation.

## Adversarial critique

The impedance table above is the critique, stated as engineering facts rather than opinions. In
summary form:

- **Queue semantics are weaker than they look.** Removal on receive rather than on completion means a
  crash between the two loses the message — which is why command authority cannot live there.
- **`wait: true` between actors deadlocks on self-send**, a sharp edge the adapter has to forbid
  outright rather than document.
- **Mutable durable state invites treating the actor as the record**, which is exactly the mistake
  that makes replay and audit impossible later.
- **Published packaging has been broken**: `rivetkit` 2.3.10's `.cjs` build uses `import.meta`, so
  `require("rivetkit")` fails and adapters must use dynamic `import()`. Small, and evidence about
  release quality.
- **Scale evidence is documentation, not a guarantee** — roughly a thousand concurrent actors on
  self-hosted Postgres is an evidence class, and marketing latency and scale numbers are not HoBo
  guarantees.
- **FoundationDB and managed-cloud backends are unverified** and therefore unsupported by the
  adapter until they are.
- **The WASM and native SDKs are distinct from the Component Model and WIT**, so "wasm" in Rivet's
  documentation does not mean what it means in HoBo's.

## Better-together / integration posture

- **Adopt / provider-target** — the preferred compatible ActorHost resolver, behind HoBo's port.
- **Benchmark** — against celld and any Durable Objects-compatible runtime, on actor density and
  local-development ergonomics.
- Not a displace, borrow, or render target; and explicitly **not** an authoring model — a Rivet actor
  definition is generated from HoBo's `actor()`, never written by a HoBo user.

## Threats and lessons

1. **Resolver semantics leak unless the adapter is written adversarially.** Every row of the
   impedance table is a place where trusting the runtime would have produced a subtly wrong system.
   This is the concrete case for `PortabilityReport` and impedance limits (ADR-0144) as a discipline
   rather than a marketing claim.
2. **Durable state is not a journal.** The most consequential distinction in this capture, and the
   easiest to get wrong when a runtime offers convenient persistence.
3. **Packaging defects are adoption defects.** A broken CommonJS build is a small fact with real
   integration cost, and it is the kind of thing only a working adapter discovers.
4. **Vendor scale numbers are never guarantees** — recorded here as an evidence class, per the
   research contract.

## Sources

- [Rivet actors documentation](https://rivet.dev/docs/actors/) and [queues](https://rivet.dev/docs/actors/queues/) — actor model, state, queue semantics
- [rivet-dev/rivet](https://github.com/rivet-dev/rivet) — source, Apache-2.0 licence
- Adapter-side evidence: the `rivetkit` 2.3.10 packaging defect and the impedance rows above were
  established while building the HoBo adapter, not taken from vendor material

FoundationDB and managed-cloud backends, and current concurrency limits, were not verified in this
pass and are explicitly unsupported rather than assumed.
