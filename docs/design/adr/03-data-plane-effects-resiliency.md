---
type: Architecture Decision Record
title: "Effects on Contracts (Verse-inspired) + Visible Secondary Resiliency"
description: "EffectSpec is first-class optional Contract IR metadata; ResilienceProfile is a secondary visible layer aligned with DX SDK resilience semantics."
tags: [hobo, design, adr, contracts, effects, resiliency]
---

# ADR-0136 — Effects on Contracts + Visible Secondary Resiliency

**Status:** Accepted  
**Date:** 2026-07-27

## Context

Boundary contracts today encode shape and edge compatibility. They do **not**
declare side effects, so:

- pure work is not isolatable by contract metadata alone;
- harness mocks drift from real I/O domains;
- resiliency intent (retry/circuit-breaker/timeout) is buried in runtime helpers
  rather than machine-readable contract surface;
- external systems (policy, SRE, MCP, agents) cannot inspect “what this boundary
  can do” without reading implementations.

Verse shows the value of **explicit effect annotations** on callable surfaces
(purity lattice, propagation, subtyping). Polly and Effect-TS show the value of
**composable resiliency strategies** as first-class policy metadata. HoBo already
has deterministic, fact-emitting resilience semantics in
[`dx-sdk-resilience-semantics.md`](../dx-sdk-resilience-semantics.md) (HOBO-514–520)
and **must not** take Effect-TS, Polly, or XState as public dependencies.

## Decision

### 1. Effects are first-class optional Contract IR fields

`BoundaryContract` may declare:

```ts
effects?: EffectSpec
resilience?: ResilienceProfile
```

**EffectSpec** (Verse-inspired, adapted for distributed systems):

| Axis | Values |
|---|---|
| Purity lattice | `pure` ⊂ `varies` ⊂ `transacts` ⊂ `noRollback` |
| Capabilities (additive) | `decides`, `suspends`, `allocates`, `concurrent` |
| Domain I/O | `network`, `storage`, `identity`, `policyEval`, `eventEmit`, `metering`, `overlayTunnel`, `iac`, `secretsResidual`, `clock`, `externalCall`, `agentTool` |

- Composition = **union** (callers declare at least callee effects).
- Subtyping: fewer/safer effects may be used where more effects are expected.
- **Effect widening** (higher purity rank, added domains/capabilities) is a
  **breaking** compatibility reason (`effect-widened`) when either side declares effects.
- Missing `effects` remains valid (opt-in). For external reasoning helpers,
  `effectiveEffects()` applies a **conservative default**
  (`noRollback` + `decides` + `network` + `externalCall`). Hash stability: absence
  is not substituted into the content hash.

### 2. Capture for external systems

- **EffectManifest** — versioned serializable export (package API, CLI, MCP, events).
- **EffectTracer / EffectSink** — records `contract.EffectDeclared` /
  `contract.EffectInvoked` facts with OTel-style attributes.
- Inspection is **replay-derived** from facts; tracers must not re-execute work on replay.

### 3. Resiliency is a visible secondary layer — not a primary primitive

- **ResilienceProfile** attaches Polly-inspired strategies as **HoBo-native types**:
  `retry` (deterministic seed/budget), `circuitBreaker`, `timeout`, `bulkhead`,
  `fallback`, `hedging`.
- Always enforces **never-retry** of `policy.Decided`, `terminal`, and
  `cancellation` per DX SDK resilience semantics.
- Thin **applyResilienceProfile** applicator emits `resilience.Attempt` /
  `resilience.Terminal` facts; no public Effect/Polly/XState dependency.
- Visibility in Gatekeeper reasons (`gate: "effects" | "resilience"`),
  `effectSummaries` on decisions, CLI describe, and MCP export.
- Resiliency **does not** become a control-plane noun alongside Policy, Harness,
  Trails, Gatekeeper, Bindle, Camp, Yard, or Junction.

### 4. Testing leverage (primary motivation)

- Pure contracts → zero-infra unit isolation via `createEffectIsolation`.
- Domain effects → automatic harness mocks (`mocksForEffects`).
- ResilienceProfile + effects → guided fault injection
  (`runResilienceFaultInjection`) with never-retry assertions.

### 5. Packages

| Concern | Package |
|---|---|
| EffectSpec, lattice, manifest, tracer | `@hobo/contracts` |
| ResilienceProfile + applicator | `@hobo/contracts` |
| IR / can-deploy / Gatekeeper | `@hobo/contracts` |
| Effect-aware isolation/mocks/fault injection | `@hobo/contracts` (kept out of `@hobo/contract-harness` to avoid a `core → harness → contracts → core` package-graph cycle) |
| Design | this ADR + `contracts-policy-flags.md` |

## Consequences

- **(+)** Machine-readable effects improve isolation testing, compatibility, and
  external export without new runtimes.
- **(+)** Resiliency intent is visible and still aligned with existing never-retry
  and deterministic-retry rules.
- **(−)** Effect annotations are opt-in; incomplete annotations yield conservative
  defaults for external helpers only.
- **(−)** Full production circuit-breaker telemetry and static TS effect checking
  are residual hardening beyond this one-shot.

## Non-goals

- No Effect-TS, Polly, or XState public dependencies.
- No algebraic user-defined effect handlers.
- No new primary resiliency control-plane noun.
- No change to `policy.Decided` meaning or terminal WIT failure semantics.
