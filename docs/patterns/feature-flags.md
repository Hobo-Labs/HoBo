---
type: Pattern
title: "Feature Flags"
description: "A feature flag (feature toggle) is a runtime switch that controls whether a code path is active, **without redeploying**. Its central value is **decoupling deploy from release**: c"
tags: [hobo, patterns]
---

# Feature Flags

> **Pattern** · decouple deploy from release via runtime flags. Sources: [OpenFeature (CNCF)](https://openfeature.dev/) · [Martin Fowler — Feature Toggles](https://martinfowler.com/articles/feature-toggles.html). Excerpts quoted for analysis (fair use).

## What it is
A feature flag (feature toggle) is a runtime switch that controls whether a code path is active, **without redeploying**. Its central value is **decoupling deploy from release**: code can ship to production "dark" (deployed but off) and be turned on — for everyone, a cohort, or a percentage — as a separate, reversible decision. This separation enables trunk-based development, gradual rollouts, instant kill-switches, and experimentation, all governed at runtime rather than at build/deploy time. The vendor-neutral standard for *evaluating* flags is **OpenFeature**; see [`../standards/openfeature.md`](../standards/openfeature.md).

## Key elements / features
- **Deploy ≠ release.** Deploying ships the artifact; flipping the flag *releases* the behavior. The two become independent levers with independent blast radius and rollback.
- **Flag types:**
  - **Boolean** — on/off (the classic toggle).
  - **Multivariate** — string/number/object/enum variants (e.g. `control` / `variant-a` / `variant-b`, or a tunable parameter).
- **Targeting & segments.** Evaluate a flag against an **evaluation context** (user id, role, tenant, region, plan, device) to serve different variants to different **segments** — "on for internal users," "on in EU," "on for tenant X."
- **Gradual / percentage rollout.** Serve a variant to an increasing percentage (1% → 10% → 50% → 100%) with consistent bucketing (the same user keeps the same variant), enabling progressive delivery decoupled from deployment.
- **Kill-switches (operational flags).** A flag that instantly disables a risky or failing feature without a rollback deploy — the fastest available mitigation.
- **Experimentation (A/B/n).** Multivariate flags + metrics make a flag the unit of an experiment: split traffic, measure outcomes, pick the winner.
- **Flag categories** (per Fowler): **release** toggles (manage in-progress features), **experiment** toggles (A/B), **ops** toggles (kill-switches, perf), **permission** toggles (entitlements/premium gating) — each with a different expected lifespan.
- **Flag lifecycle & debt.** Flags are inventory: created, rolled out, then **retired**. Stale flags accumulate as **flag debt** — dead branches, confusing config, combinatorial test surface. Healthy practice tracks ownership, expiry, and cleanup of each flag.
- **Standardized evaluation (OpenFeature).** A vendor-neutral API + **provider** model: application code calls a stable evaluation API (`getBooleanValue(...)` etc.) and a swappable provider (LaunchDarkly, Unleash, Flagsmith, in-house) backs it, with **evaluation context** and **hooks** (before/after/error/finally) for logging, validation, and telemetry. CNCF incubating, Apache-2.0. See [`../standards/openfeature.md`](../standards/openfeature.md).

## Relevance to HoBo
Feature flags are the **release-decoupling complement to HoBo's deploy-time gates** — and they fit HoBo's architecture as cleanly as any other capability.

**Adopt behind an OpenFeature-compatible port.** Consistent with HoBo's recurring stance (speak existing standards at the boundary; engines behind a WIT port), the analysis points to a **`feature-flag` capability** exposed through an **OpenFeature-compatible** port: app code evaluates flags against `ctx`-derived context, while the backing provider (an in-house event-sourced store, or LaunchDarkly/Unleash/Flagsmith) sits behind the seam and is selected per Camp — no app-code change to swap. The **evaluation context** maps naturally onto HoBo's existing principals: `ctx.user` claims (roles/scopes/tenant, [Plan 6](../design/ai-native-agent-auth.md#plan-06)) and Camp/environment type ([Plan 25](../design/platform-engineering.md#plan-25)) are exactly the targeting dimensions flags need.

**Flags vs HoBo's gates — complementary, not redundant.** HoBo's `can-deploy` gating and policy obligations ([Plan 25](../design/platform-engineering.md#plan-25)/[Plan 29](../design/contracts-policy-flags.md#plan-29)) decide *whether an artifact may be deployed*; feature flags decide *whether deployed behavior is released*. The two operate at different times and granularities:
- **Progressive rollout overlap.** HoBo already does percentage rollout at the *infrastructure* layer — canary/progressive saga strategies (1%→10%→50%→100% with gates, [Plan 5](../design/reliability-observability-cost.md#plan-05)) — and policy can *force* a canary as an **obligation** ("allow deploy → require canary," [Plan 29](../design/contracts-policy-flags.md#plan-29)). Feature flags add the **application-layer** equivalent: rolling out a *feature within an already-deployed artifact*, finer-grained and independent of the deploy. They complement, rather than replace, the saga-level rollout.
- **Kill-switch as fastest mitigation.** Where HoBo's auto-rollback re-applies a previous immutable Set ([Plan 25](../design/platform-engineering.md#plan-25)), a flag kill-switch disables behavior with no deploy at all — a faster first response that the HA model can trigger before a full rollback.

**Flags could be policy-gated and event-sourced — the HoBo-native twist.** The strongest fit is to treat a flag flip like any other governed action:
- **Event-sourced flag state.** Each evaluation/flip becomes an event ([Plan 11](../design/data-plane.md#plan-11)), so "who turned this on, for which segment, when, and what did each user see?" is replayable and auditable — the same audit story HoBo gives deploys and token issuance.
- **Policy-gated flips.** A high-risk flip (enable a feature for 100% of prod) can ride the **policy plane** ([Plan 29](../design/contracts-policy-flags.md#plan-29)) — `phase: apply`/`runtime` decisions with obligations ("allow but require approval," "require shadow eval") and `policy.Decided` evidence — so flag changes inherit the same gate model as everything else.
- **Experimentation ties into evals.** Multivariate-flag experiments share the champion/challenger + shadow-traffic + min-samples machinery HoBo already defines for trainable methods ([Plan 23](../design/generated-stack.md#plan-23)) — flags as the routing layer, evals as the measurement.

**Now owned by a Plan (was a gap).** This pattern surfaced as open question [#24](../design/generated-stack.md#plan-09) and is **resolved by [Plan 29](../design/contracts-policy-flags.md#plan-29)** ([ADR-0044](../design/adr/02-identity-security.md#adr-0044)): a first-class **OpenFeature-compatible `feature-flag` port** (built-in store default; OpenFeature providers as adapters), IfC flag definitions, **in-process deterministic** evaluation (targeting via `ctx.user`/`ctx.identity`), **event-sourced** (`flag.*`) + **optionally policy-gated** flips + **reactive** re-eval — composing canary (deploy dial) + flag `%` (release dial) for progressive delivery.

## Sources
- [OpenFeature — vendor-neutral feature flag API (CNCF)](https://openfeature.dev/)
- [OpenFeature specification](https://openfeature.dev/specification/)
- [Martin Fowler — Feature Toggles (aka Feature Flags)](https://martinfowler.com/articles/feature-toggles.html)
- HoBo internal cross-refs: [Plan 5](../design/reliability-observability-cost.md#plan-05) · [Plan 11](../design/data-plane.md#plan-11) · [Plan 23](../design/generated-stack.md#plan-23) · [Plan 25](../design/platform-engineering.md#plan-25) · [Plan 29](../design/contracts-policy-flags.md#plan-29) · [Plan 6](../design/ai-native-agent-auth.md#plan-06)
