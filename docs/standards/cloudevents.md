---
type: Reference Standard
title: "CloudEvents (CNCF)"
description: "CloudEvents is \"a specification for describing event data in a common way.\" It defines a **vendor-neutral event envelope** — a small set of metadata (\"context attributes\") wrapped "
tags: [hobo, standards]
---

# CloudEvents (CNCF)

> **Standard** · Open specification for describing event data in a common way. Source: [cloudevents.io](https://cloudevents.io/) · [spec v1.0.2](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md) · [CNCF](https://www.cncf.io/projects/cloudevents/). Excerpts quoted for analysis (fair use).

## What it is
CloudEvents is "a specification for describing event data in a common way." It defines a **vendor-neutral event envelope** — a small set of metadata ("context attributes") wrapped around an opaque `data` payload — so that events can cross systems, vendors, and protocols without each producer/consumer reinventing the envelope. It is a **CNCF graduated project** (graduated 2024-01-25) and originated in the CNCF Serverless Working Group. The current spec line is **v1.0.x** (latest patch v1.0.2).

The goal is **interoperability**: a Kafka topic, an HTTP webhook, an MQTT broker, and a serverless function can all exchange the *same* event with the *same* identity and type, because the envelope is standardized and the protocol bindings define how to map it onto each transport.

## Key features
- **Required context attributes** (every CloudEvent MUST have these four):
  - `id` — identifies the event; producers MUST ensure `source` + `id` is unique per distinct event (non-empty string).
  - `source` — "the context in which an event happened"; a non-empty URI-reference (absolute URI recommended).
  - `specversion` — the CloudEvents spec version; MUST be `"1.0"` for this line.
  - `type` — describes the kind of occurrence; used for routing/observability/policy; SHOULD be reverse-DNS prefixed (e.g. `com.example.object.created`).
- **Optional context attributes:**
  - `datacontenttype` — RFC 2046 media type of `data` (defaults to `application/json` in JSON format).
  - `dataschema` — URI to the schema `data` adheres to.
  - `subject` — subject of the event within the producer's context (filtering aid when middleware can't read `data`).
  - `time` — RFC 3339 timestamp of when the occurrence happened.
- **`data`** — the optional, opaque domain payload, encoded per `datacontenttype`.
- **Extension attributes** — producers MAY add any number of additional named context attributes (e.g. `traceparent`, `partitionkey`, `sequence`, `dataref`); they follow the same naming/type rules but carry no spec-defined meaning. Documented extensions exist for distributed tracing, partitioning, sequence, and more.
- **Event formats** — define how an event serializes: **JSON** (mandatory baseline), plus **Avro**, **Protobuf** (batching added in v1.0.2), and **XML**.
- **Protocol bindings** — define how an event maps onto a transport, in two modes: **structured** (whole event in the body) or **binary** (context attributes → transport headers, `data` → body). Bindings: **HTTP**, **Kafka**, **AMQP**, **MQTT**, **NATS**, and **WebSockets** (added v1.0.1).
- **SDKs** — official SDKs for **Go, JavaScript, Java, C#, Ruby, PHP, Python, Rust, and PowerShell**.
- **Related specs** — the CloudEvents family also includes a **Subscriptions API** and **Discovery** spec (event-source/type discovery and managed subscriptions); CNCF **Serverless Workflow** builds on CloudEvents.

## Relevance to HoBo
HoBo already has its own envelope — the `EventEnvelope<T>` in [Plan 11](../design/data-plane.md#plan-11) — and the two are close cousins. The pointed question is **not "should HoBo replace its envelope with CloudEvents"** (it shouldn't — HoBo's envelope carries event-sourcing semantics CloudEvents deliberately omits), but **"should HoBo's envelope be CloudEvents-*compatible* and emit CloudEvents at its boundary"** for interop with external consumers and eventing systems. The answer this analysis supports: **yes, at the boundary; keep the richer internal envelope.**

**Field mapping (HoBo `EventEnvelope` ↔ CloudEvents):**

| HoBo field | CloudEvents attribute | Notes |
|---|---|---|
| `id` (ULID) | `id` | Direct; ULID satisfies "unique per source". |
| `type` (`deployment.Provisioned`) | `type` | HoBo uses `aggregate.PastTenseFact`; CloudEvents SHOULDs a reverse-DNS prefix (e.g. `io.hobo.deployment.Provisioned`). |
| `streamId` (`deployment:01H…`) | `source` (+ `subject`) | The aggregate/stream is the natural `source`; the specific instance maps to `subject`. |
| `ts` (ISO8601, Clock) | `time` | Direct (RFC 3339). |
| `data` | `data` | Direct. |
| `v` (schema version) | `dataschema` *or* extension | Map to a `dataschema` URI, or a `hoboschemaversion` extension. |
| `actor` (`PrincipalRef`) | extension (`hoboactor`) | No native CloudEvents equivalent. |
| `tenant` | extension (`hobotenant`) | Isolation boundary ([Plan 12](../design/security-networking.md#plan-12)). |
| `causationId` / `correlationId` | extensions / `traceparent` (`meta`) | HoBo's `meta.traceparent` already aligns with the CloudEvents distributed-tracing extension ([Plan 5](../design/reliability-observability-cost.md#plan-05)). |
| `seq` (per-stream monotonic) | `sequence` extension (partial) | HoBo's `seq` is stronger (optimistic-concurrency key), not just ordering. |

**What HoBo keeps beyond CloudEvents.** CloudEvents is a *transport envelope*; HoBo's is an *event-sourcing* envelope. `seq` (per-stream monotonic, used for optimistic-concurrency appends), `causationId`/`correlationId` (causal/saga graph), `v` + **upcasters** (replayable schema evolution, [Plan 11](../design/data-plane.md#plan-11) §Schema evolution), and the append-only-log-as-source-of-truth semantics have **no CloudEvents counterpart** — and shouldn't, because CloudEvents intentionally says nothing about ordering, storage, or replay. So HoBo's internal log stays richer.

**Where emitting CloudEvents pays off.** HoBo's stance (per [`README`](./index.md)) is to *speak existing standards at its boundaries*. CloudEvents is exactly that boundary format for **outbound** events: webhooks, a tenant's eventing bus (Knative/EventBridge/Kafka), or pipeline triggers ([Plan 25](../design/platform-engineering.md#plan-25)) should receive **binary-mode CloudEvents over HTTP/Kafka** projected from the internal envelope. This also dovetails with the normalized `data.Changed` change-feed events ([Plan 11](../design/data-plane.md#plan-11), [Plan 32](../design/data-plane.md#plan-32)) and the security-event export discussed in [`ocsf.md`](./ocsf.md): CloudEvents is the *envelope*, OCSF the *payload schema*, for security events leaving HoBo.

**Recommendation.** Treat CloudEvents as an **emit-at-the-boundary** projection (one mapping function, one `dataschema`/extension registry), not an internal model change. Keep `EventEnvelope` as the authoritative internal shape; add a `toCloudEvent()` adapter and a small set of registered HoBo extension attributes. This is a low-cost interop win with no compromise to the event-sourcing guarantees that are a HoBo differentiator.

## Sources
- [CloudEvents — cloudevents.io](https://cloudevents.io/)
- [CloudEvents Specification v1.0.2 (core)](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)
- [CloudEvents spec repository](https://github.com/cloudevents/spec)
- [CloudEvents Primer](https://github.com/cloudevents/spec/blob/main/cloudevents/primer.md)
- [CNCF — CloudEvents project](https://www.cncf.io/projects/cloudevents/)
- HoBo: [Plan 11 — Event model](../design/data-plane.md#plan-11) · [Plan 14 — Observability](../design/reliability-observability-cost.md#plan-05) · [Plan 12 — Security & multi-tenancy](../design/security-networking.md#plan-12) · [Plan 28 — Agent/GitOps pipelines](../design/platform-engineering.md#plan-25)
