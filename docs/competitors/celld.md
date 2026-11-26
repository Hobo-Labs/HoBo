---
type: Competitive Reference
title: "celld — competitor reference"
description: "Deno's celld as a future independent Durable Objects resolver; pinned image and honest role notes."
tags: [hobo, competitors]
competitor:
  slug: celld
  name: "celld"
  primary_category: runtime-substrates
  categories: [runtime-substrates]
  directness: adjacent
  role: "self-hosted Cloudflare Workers/Durable Objects daemon — experimental DO dialect and candidate ActorHost"
  posture: [adopt, provider-target]
  hobo_surface: [runtime-portability, reconciliation]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://github.com/denoland/celld
---

# celld

**Checked:** 2026-08-14  
**Pin:** `ghcr.io/denoland/celld:v0.2.1@sha256:7a4380721b6400073f2a26afe70a828410169f658d31b5ef61383e648ca0c530`  
**Sources:** [github.com/denoland/celld](https://github.com/denoland/celld), [v0.2.1](https://github.com/denoland/celld/releases/tag/v0.2.1), [celld.dev/docs](https://celld.dev/docs)  
**License:** Apache-2.0  
**HoBo role:** experimental Durable Objects dialect (`@hobo/runtime-celld`), sibling of `runtime-cloudflare`. Not a WASM Component Model host.

## What it is

celld is a **self-hosted Cloudflare Workers / Durable Objects daemon** from Deno: a V8-based runtime
with one SQLite database per cell and content-addressed storage in S3 or GCS. Apache-2.0, pinned in
HoBo at `v0.2.1`.

Its role in HoBo is deliberately bounded: an **experimental Durable Objects dialect**
(`@hobo/runtime-celld`), a sibling of `runtime-cloudflare`, and explicitly **not** a WASM Component
Model host.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Cell** | The addressable unit, analogous to a Durable Object, with its own SQLite database |
| **Fleet** | The deployment grouping — one application per fleet |
| **CAS** | Content-addressed storage in S3 or GCS, with LTX for SQLite transaction shipping |
| **Operator API** | The control interface for managing cells and fleets |
| **V8 Worker** | The execution environment; WASM runs *inside* it rather than being the model |

The mental model is **Durable Objects you can run yourself**. That is a genuinely useful thing to
exist, and the capture below is mostly about the conditions under which it is safe to rely on.

## How it competes with HoBo

celld is **adopted with conditions**, not contested. It is one ActorHost resolver among siblings
(Rivet, Cloudflare, local), and the impedance table is the operative content of this capture.

| Surface | Relationship |
| ------- | ------------ |
| `runtime-portability` | One resolver behind HoBo's ActorHost port |
| `reconciliation` | Cell lifecycle managed by the operator API |

## Feature surface

- Cells with per-cell SQLite and Durable-Objects-shaped addressing.
- Content-addressed storage in S3 or GCS, with LTX for transaction shipping.
- An operator API for fleet and cell management.
- V8-based Worker execution, with WASM supported inside the isolate.
- Partial Cloudflare-compatible surfaces — Queues, KV, R2 and Cron are **incomplete**.

## Architecture

- **Execution** — V8 Workers, so the programming model is Cloudflare's rather than the Component
  Model's.
- **Storage** — one SQLite database per cell, with CAS ownership in object storage and LTX shipping
  transactions. There is **no filesystem mode**, which is why celld is never the `hobo dev` default.
- **Control** — an operator API that is, in the pinned version, **unauthenticated**, and peers that
  communicate **without TLS**.
- **State authority** — the cell's SQLite. As with Rivet, HoBo keeps its journal as the record rather
  than trusting runtime state.
- **Portability boundary** — a Cloudflare dialect, incompletely implemented. Code written for celld
  is closer to Cloudflare than to anything else, and the incompleteness is the boundary.

## Impedance

| Fact | HoBo consequence |
|---|---|
| One SQLite per cell, S3/GCS CAS ownership, LTX | Grain key → cell name; journal is HoBo’s |
| No filesystem mode | Never `hobo dev` default |
| No TLS on peers; unauthenticated operator API | Overlay required; public operator port fails closed |
| Unsafe hostile multi-tenant | One fleet per trust boundary |
| WASM inside V8 Worker | Not `runtime-wasm` / WIT |
| One app per fleet | Not a shared public actor SaaS |
| Queues/KV/R2/Cron incomplete | Do not claim private Cloudflare |

celld-on-Flux is **unsupported** until the ten overlay/capacity proofs in `@hobo/runtime-celld` pass.

## Primitive mapping

| HoBo | celld |
|---|---|
| `actor()` | Named cell + HoBo inbox/journal in cell SQLite |
| Station | Isolation domain that may own one fleet — not a new topology noun |
| Bucket | User-owned S3/R2/GCS with proven CAS; NATS OS unproven |

## Where celld is stronger

- **Self-hosted Durable Objects exist at all.** Running a DO-shaped runtime without Cloudflare is a
  real capability gap this fills.
- **Per-cell SQLite with CAS in the operator's own object storage** keeps data ownership with the
  operator.
- **Apache-2.0 and pinnable by digest**, which is what makes cautious adoption possible.
- **LTX transaction shipping** is a sound mechanism for durability over object storage.

## Where HoBo is stronger or intentionally different

- **The journal is HoBo's** (*implemented*, ADR-0135); the cell's SQLite holds runtime state, not the
  record of facts.
- **Actors are portable across resolvers** (*implemented*): celld is a sibling of Rivet and
  Cloudflare behind one port, so its dialect never becomes HoBo's model.
- **Trust boundaries are explicit** (*implemented*, ADR-0146 and the Station model): because celld is
  unsafe for hostile multi-tenancy, HoBo's rule is one fleet per trust boundary rather than a shared
  fleet with tenant isolation.
- **Honest caveat.** HoBo adds discipline around celld; it does not make celld's security properties
  better than they are.

## Adversarial critique

The impedance table above is the critique in operational form. The security facts deserve restating
plainly, because they are the ones that decide deployment:

- **Peers communicate without TLS and the operator API is unauthenticated** in the pinned version.
  This is not a subtlety: an exposed operator port is a full compromise, which is why HoBo requires
  an overlay and fails closed on a public operator port.
- **Explicitly unsafe for hostile multi-tenancy**, hence one fleet per trust boundary and no shared
  public actor service.
- **One application per fleet** caps density and makes the economics of small deployments poor.
- **Cloudflare-compatible surfaces are incomplete** — Queues, KV, R2 and Cron — so "a private
  Cloudflare" is a claim HoBo must not make.
- **No filesystem mode** rules it out as a local development default.
- **WASM runs inside a V8 Worker**, which is not the Component Model and must not be conflated with
  `runtime-wasm` or WIT.
- **Early version, small project.** `v0.2.1` is what the version number suggests it is, and the
  pinned digest exists because that matters.
- **celld-on-Flux is unsupported** until the ten overlay and capacity proofs in `@hobo/runtime-celld`
  pass — a concrete, testable gate rather than a judgement call.

## Better-together / integration posture

- **Adopt with conditions / provider-target** — one ActorHost resolver behind HoBo's port, gated on
  the overlay and capacity proofs.
- **Benchmark** — against Rivet and Cloudflare on cell density, durability behaviour and operational
  safety.
- Not a displace, borrow, or render target, and not an authoring model.

## Threats and lessons

1. **A pinned digest and a proof gate are how you adopt an early runtime responsibly.** This capture
   is the clearest example in the corpus of impedance discipline applied to a real dependency, and
   the ten-proof gate is the mechanism that keeps optimism out of the deployment decision.
2. **Security properties are impedance too.** No TLS between peers and an unauthenticated operator
   API are not features to route around quietly; they change the deployment topology, and the
   capture says so.
3. **Compatibility claims must be bounded by completeness.** Partial Cloudflare surfaces mean HoBo
   cannot claim private Cloudflare, and stating that limit protects HoBo's own credibility.
4. **Siblings behind one port are the answer to early-runtime risk** — if celld does not mature, the
   ActorHost port absorbs the change.

## Sources

- [denoland/celld](https://github.com/denoland/celld) and [v0.2.1 release](https://github.com/denoland/celld/releases/tag/v0.2.1) — source, licence, pinned digest
- [celld.dev/docs](https://celld.dev/docs) — cells, fleets, operator API, storage model
- Adapter-side evidence: the impedance rows, security facts and the ten-proof gate were established
  while building `@hobo/runtime-celld`, not taken from vendor material

Queue, KV, R2 and Cron completeness, and any change to the operator API's authentication, were not
re-verified in this pass; the pinned version's behaviour is what this capture describes.
