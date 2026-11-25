---
type: Reference Standard
title: "OpenFeature (CNCF)"
description: "**OpenFeature** is an open specification and set of SDKs providing a **vendor-agnostic, community-driven API for feature flagging** that works with any feature-flag management tool"
tags: [hobo, standards]
---

# OpenFeature (CNCF)

> Standard — vendor-neutral feature-flag evaluation API + SDK + provider model. Source: [openfeature.dev](https://openfeature.dev/) · [Intro](https://openfeature.dev/docs/reference/intro/) · [Providers](https://openfeature.dev/docs/reference/concepts/provider/) · [Specification](https://openfeature.dev/specification/) · [flagd](https://flagd.dev/). CNCF incubating project. Excerpts quoted for analysis (fair use).

## What it is
**OpenFeature** is an open specification and set of SDKs providing a **vendor-agnostic, community-driven API for feature flagging** that works with any feature-flag management tool. It was accepted as a **CNCF incubating project** (December 2023). The goal is to standardize *how applications evaluate flags* so that swapping the backing flag system (LaunchDarkly, Flagsmith, Split, a homegrown service, a local file, …) is a configuration change, not a code rewrite.

The model has three moving parts the application author cares about: the **Evaluation API** (what your code calls), a **Provider** (the pluggable translation layer to a specific flag system), and the **Evaluation Context** (the data flag evaluation is keyed on).

## Key features
- **Flag Evaluation API**: the developer-facing surface. Code requests a flag value with a key, a default, and (optionally) context; the SDK returns the resolved value (and, via detailed variants, a reason/variant/error). Defaults are returned if no provider is configured or a provider errors — evaluation **fails safe**.
- **Flag value types** — four: **boolean**, **string**, **number** (integer/float), and **object/structure** (arbitrary JSON). Each has typed evaluation methods (e.g. `getBooleanValue`, `getObjectDetails`).
- **Providers**: the "translation layer" between the API and the underlying flag system. A single provider is registered globally; a provider may wrap a vendor SDK, call a bespoke REST API, or parse a local file. Swapping providers requires no application-logic change.
- **Evaluation context**: a container for arbitrary contextual data used as the basis for dynamic evaluation (e.g. user id, region, tenant, host). Static/global context (app identifier, host) plus per-request dynamic context drive targeting.
- **Hooks**: extension points across the evaluation lifecycle (`before`/`after`/`error`/`finally`) for validation, logging, **telemetry**, and mutating/adding to the evaluation context — the standard integration seam for observability and policy.
- **Events**: respond to provider state changes (ready, error, configuration changed/stale) so apps can react to flag-config updates at runtime.
- **Server vs client SDKs**: **server-side** SDKs use **dynamic** evaluation context that varies per request (multi-user); **client-side / web** SDKs use a **static** context updated explicitly (`setContext` / `onContextChange`) for a single user/session.
- **Broad SDK coverage**: Node.js, Go, Java, Python, .NET, Ruby, Rust, PHP, C++, Dart (server) and iOS, Kotlin/Android, Web (with React/Angular bindings) (client).
- **flagd**: OpenFeature's reference **feature-flag daemon** — a standalone, lightweight evaluation engine that reads flag definitions (files, HTTP, gRPC, Kubernetes sources) and exposes them through an OpenFeature provider, giving a self-hostable, vendor-free flag backend.

## Relevance to HoBo
OpenFeature is the **standard HoBo should speak** for flag evaluation — exposed as an optional `feature-flag` capability behind a port — and it dovetails with HoBo's policy obligations and progressive-rollout machinery.

> **Adopted:** this is now specified in **[Plan 29](../design/contracts-policy-flags.md#plan-29)** ([ADR-0044](../design/adr/02-identity-security.md#adr-0044)) — an OpenFeature-compatible `feature-flag` port (built-in store default; OpenFeature providers as adapters), event-sourced + optionally policy-gated + reactive. The notes below are the rationale.

- **The feature-flags pattern's standard.** OpenFeature is the standard underpinning HoBo's feature-flags pattern ([`../patterns/feature-flags.md`](../patterns/feature-flags.md)). Consistent with HoBo's "speak existing standards at the boundary" stance, HoBo should expose flag evaluation through the **OpenFeature evaluation API + provider model** rather than inventing a proprietary flag API — an optional `feature-flag` capability behind a WIT port, with providers (flagd, vendor SDKs, a HoBo-native default) selected per Camp.
- **Policy obligations & progressive rollout** ([`../design/30-policy-plane.md`](../design/contracts-policy-flags.md#plan-29)). Plan 30's **obligations** include "allow deploy → require canary" and "allow model change → require shadow evaluation." A feature flag is the natural runtime lever for such obligations: a canary or progressive rollout is, operationally, a flag whose targeting widens over time. OpenFeature's **evaluation context** (region, tenant, user, cohort) is exactly the input a HoBo obligation/saga would set to drive a graduated rollout, and OpenFeature **hooks** are a clean seam to emit `policy.Decided`-style evidence on each evaluation.
- **Canary / reliability** ([`../design/05-reliability-ha.md`](../design/reliability-observability-cost.md#plan-05)). HoBo's canary rollouts (and the durable obligation/saga that enforces "require canary") can be implemented as widening flag targeting; OpenFeature gives that a standard, vendor-neutral API so the rollout logic isn't coupled to one flag vendor — preserving HoBo's portability promise ([ADR-0024](../design/adr/07-portability-extensibility.md#adr-0024)).
- **Evaluation context ↔ HoBo's decision request.** OpenFeature's evaluation context (subject + attributes) closely mirrors the `subject`/`context` of a HoBo policy **decision request** (Plan 30) and the verified `ctx.user` end-user claims ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) — the same contextual data could feed both flag evaluation and policy decisions, keeping targeting and authorization consistent.
- **Telemetry alignment.** OpenFeature hooks for telemetry map onto HoBo's OTel/OpenInference observability ([`../design/14-observability.md`](../design/reliability-observability-cost.md#plan-05)) — flag-evaluation spans/events become part of the same trace surface as policy decisions and contract gates.

Net: **adopt-at-the-boundary.** OpenFeature is the API HoBo should expose for flag evaluation (optional `feature-flag` capability behind a port, flagd/vendors as providers); it is also the runtime mechanism most aligned with Plan 30 progressive-rollout obligations and Plan 5 canaries.

## Sources
- OpenFeature homepage — https://openfeature.dev/
- Introduction — https://openfeature.dev/docs/reference/intro/
- Providers concept — https://openfeature.dev/docs/reference/concepts/provider/
- Flag evaluation API (specification) — https://openfeature.dev/specification/sections/flag-evaluation/
- Hooks — https://openfeature.dev/docs/reference/concepts/hooks/
- flagd — https://flagd.dev/
