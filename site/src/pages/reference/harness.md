---
layout: ../../layouts/Docs.astro
title: Harness & progressive delivery
description: "OpenFeature flags, OpenDelivery, OpenExperiment, gateway weights, sandbox lanes, and composition with Trails and Gatekeeper."
---

# Harness & progressive delivery

**Harness** is the flags / progressive delivery / experiments plane. It is **not** a second infrastructure control plane — it routes **traffic and contract observation** safely.

## Standards-shaped cores

| Core | Role |
|---|---|
| **OpenFeature** | Sole public flag evaluation API for application code (`HoboOpenFeatureProvider` / `HoboFeatureClient`) |
| **OpenDelivery** (HoBo-shaped) | Progressive delivery / weight shifts |
| **OpenExperiment** (HoBo-shaped) | Bounded experiments with metrics hooks |
| **OpenTelemetry hooks** | Export observation without inventing a parallel telemetry product |

`FeatureFlagStore` + delivery + experiment engines are composed by `Harness`.

## Capabilities

| Capability | Role |
|---|---|
| Feature flags | Ranked evaluation with audit facts |
| Experiments | Bounded exposure |
| Gateway weights | Shift traffic across revisions/camps |
| Sandbox lanes | Isolate experimental contract observations |
| Delivery composition | Safe rollout steps shared with Trails |
| Continuous delivery plane | Workload-attested apply of Gatekeeper-approved sets (cloud control plane CD) composes Harness |

## Rules

1. Baseline subscribers **ignore** sandbox-lane events by default.
2. Flag changes are **facts** — replayable, not console memory.
3. Progressive steps still pass **Gatekeeper** when they mutate infra.
4. Trails compose Harness for cutover; pure flag flips need no Trail.
5. Agents change flags only under RBAC + policy (often require-approval in prod).
6. App code evaluates flags through **OpenFeature** — not ad-hoc env bools that bypass audit.

## CLI

`hobo feature …` for flag/progressive ops. Observe via `inspect` projections and event replay.

## Testing

- Dual fixtures for flag on/off paths.
- Bridge shadow mode to compare experimental vs baseline.
- Chaos: partial weight shifts must not break claimed session consistency.

## Related

[Progressive delivery guide](/HoBo/cicd/progressive-delivery/) · [Trails](/HoBo/primitives/trails/) · [Bridge modes](/HoBo/testing/bridge-modes/) · [Identity](/HoBo/reference/identity/) · [Matching](/HoBo/reference/matching/)
