---
type: Technology Reference
title: "Pact"
description: "**Pact** is a code-first, open-source tool for **consumer-driven contract testing**: verifying an integration point by testing each side **in isolation** so the messages a service "
tags: [hobo, technologies]
---

# Pact

> Technology — consumer-driven contract testing framework + the Pact Broker. Source: [docs.pact.io](https://docs.pact.io/) · [Consumer guide](https://docs.pact.io/consumer) · [Pact Broker](https://docs.pact.io/pact_broker) · [PactFlow docs](https://docs.pactflow.io/) · [GitHub `pact-foundation`](https://github.com/pact-foundation). Excerpts quoted for analysis (fair use).

## What it is
**Pact** is a code-first, open-source tool for **consumer-driven contract testing**: verifying an integration point by testing each side **in isolation** so the messages a service sends or receives conform to a shared understanding. Rather than spinning up every dependency in an end-to-end environment, Pact tests the **consumer** against a mock provider and the **provider** against the consumer's recorded expectations. Because the contract is generated from what the consumer actually exercises, "only parts of the communication actually used by the consumer get tested" — the provider can change unused behavior freely. It is **contract by example**: each interaction is a concrete request/response (or message) pair enforced by automated tests.

## Key features
- **Consumer test → pact file.** The consumer's unit tests run against a Pact **mock server**; each request/expected-response interaction is recorded into a **pact file** (a JSON document of all interactions between one consumer/provider pair).
- **Provider verification.** The provider replays every recorded request against the real provider and checks the actual response matches the consumer's expectation. Pass = the provider satisfies that consumer; fail = it would break the consumer *before* deploying.
- **Matchers.** Type/regex/flexible matchers describe the *shape* of acceptable responses (not exact values), keeping contracts robust to non-meaningful change.
- **Message pacts.** Beyond HTTP request/response, Pact supports **asynchronous / message** contracts (events, queues, topics) — payload shape verification for producers/consumers of messages.
- **The Pact Broker** (open-source) / **PactFlow** (commercial SaaS): the operational backbone — stores contracts, tracks verification status across versions, and enables release gating. Key Broker capabilities:
  - **`can-i-deploy`** — a CLI/API gate that answers "is it safe to deploy version X of this app to environment E?" by confirming every contract the app participates in has been **verified against the versions currently live in the target environment**. The final gate before a CI/CD deploy.
  - **The Matrix** — the cross-product of every consumer/provider application **version** and their verification results; `can-i-deploy` is a query over this matrix.
  - **Versioning + tags / branches / environments** — application versions are tagged/recorded per branch and per deployed environment, so the Broker knows what is actually running where.
  - **Webhooks** — fire on contract changes / verification results to trigger provider verification builds or notifications.
- **Bi-directional contracts** (PactFlow): the provider publishes **its own** contract (typically derived from an **OpenAPI** spec) and the Broker **cross-validates** the consumer's pact against it — instead of replaying requests against a running provider. Trades some fidelity for speed and decoupling (no live provider verification job).
- **Broad language support** — JS/TS, Java/JVM, .NET, Go, Python, Ruby, PHP, Rust, Swift, etc., via the shared Pact spec.

## Relevance to HoBo
Pact is the named **optional provider** behind HoBo's contract port, and Pact Broker's `can-i-deploy` is the direct ancestor of HoBo's `can-deploy` gate — but HoBo derives contracts from its own graph + event log instead of from per-consumer test files.

- **`contract-engine` WIT port with Pact as an optional provider** ([`../design/29-contracts-compatibility.md`](../design/contracts-policy-flags.md#plan-29)). Plan 29 defines a `contract-engine` port whose **default** is the built-in HoBo implementation (it already has the graph, traces, and event log it needs). **Pact (`@hobo/provider-pact`)** is an optional provider that can "export HoBo contracts to Pact interactions/message pacts, run Pact provider verification, and mirror a Pact Broker's `can-i-deploy`" — for teams already invested in that ecosystem. HoBo owns the source of truth (the **HoBo Contract IR**); Pact / OpenAPI / AsyncAPI / Protobuf are import/export targets, never the model.
- **`can-deploy` is HoBo's generalization of `can-i-deploy`** ([`../design/29-contracts-compatibility.md`](../design/contracts-policy-flags.md#plan-29)). HoBo's gate builds a **compatibility matrix** of the proposed deployment's producer/consumer **versions** vs the versions the **event log** says are running in the target environment, and blocks incompatible skew with a precise, machine-readable reason. Plan 29 states this explicitly: "This is HoBo's generalization of consumer-driven contract testing's `can-i-deploy`, but driven by HoBo's own graph + event log (not an external broker)." The key inversion: Pact's matrix is populated by **published pact files + verification results**; HoBo's is populated by **trace-mined observed contracts** and graph compilation.
- **`compat.GatePassed` / `compat.GateFailed` events** ([`../design/11-event-model.md`](../design/data-plane.md#plan-11)). Where Pact stores verification status in the Broker, HoBo records each gate result as an event, so "why did this deploy block?" is replayable — the audit equivalent of the Broker's verification history, native to HoBo's event model.
- **Contracts beyond HTTP.** Pact covers HTTP + message pacts; HoBo's contract dimension spans **every edge kind** in the manifest graph (HTTP, events, resource bindings, capabilities/`.allow()` scopes, SLOs, semantic functions, agent tools, provider conformance) — Pact's message pacts map to HoBo's event-edge contracts, but HoBo's coverage is broader.
- **Inference vs hand-authored.** Pact contracts are written as consumer tests; HoBo contracts are **declared / inferred / observed / promoted** (Plan 29's four modes), so developers rarely hand-write them. Pact's bi-directional model (provider publishes OpenAPI; Broker cross-validates) is the closest analogue to HoBo's "declared from WIT/Zod, cross-checked against observed reality."

Net: **adopt-behind-a-port + informs.** Pact is the canonical optional contract provider and the conceptual parent of `can-deploy`; HoBo keeps the Contract IR, graph-driven matrix, and event-sourced gate results as its own.

## Sources
- Pact introduction — https://docs.pact.io/
- Writing consumer tests — https://docs.pact.io/consumer
- Provider verification — https://docs.pact.io/provider
- Pact Broker (`can-i-deploy`, matrix, webhooks, versioning) — https://docs.pact.io/pact_broker
- `can-i-deploy` — https://docs.pact.io/pact_broker/can_i_deploy
- Bi-directional contract testing (PactFlow) — https://docs.pactflow.io/docs/bi-directional-contract-testing
- GitHub (Pact Foundation) — https://github.com/pact-foundation
