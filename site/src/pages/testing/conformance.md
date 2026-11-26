---
layout: ../../layouts/Docs.astro
title: Conformance & golden suite
description: "Port conformance suites, SDK semantics annex, and the golden suite as a deploy gate dimension."
---

# Conformance & golden suite

## Port conformance

Every implementable port (runtime EventStore, provider adapters, IaC engines, …) ships a **conformance suite**. Human- and AI-authored adapters must pass the same suite to be certified. conformance suite hosts shared suites (for example EventStore append/idempotency/replay).

## SDK semantics annex

Resilience, cancellation, deadlines, lifecycle tables, and supervision are pinned by the **DX SDK resilience semantics** matrix — Contract-visible ResilienceProfile application **must** obey that matrix (never-retry rules, deterministic schedules, fact-based inspection).

## Golden suite (deploy gate)

The **golden suite** is a first-class Gatekeeper dimension: a signed, reproducible bundle that pins contracts, evals, conformance, benchmarks, chaos, and golden-master samples. Failures are structured, event-sourced, and can open Crew remediation (propose fix / A2H).

## Behavior / Cucumber

Executable Gherkin features live under `features/` for high-level evidence (durable journal scenarios, effects/resiliency scenarios). They complement package unit tests; they are not live multi-cloud E2E.

## What “green” means

| Lane | Meaning |
|---|---|
| Unit / package | Implementation correct in isolation |
| Contract consumer/provider | Boundary expectations hold |
| Conformance | Port claim is honest |
| can-deploy / Gatekeeper | Version skew + policy + cost ok |
| Golden | Reproducible multi-check bundle ok |

## Next

- [Reference overview](/HoBo/reference/)
- [Trail map](/HoBo/guide/status/)
