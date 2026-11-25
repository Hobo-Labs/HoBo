---
type: Architecture Decision Record
title: "Yard-first placement and primitive-scoped provider resolvers"
description: "Yard-first placement and primitive-scoped provider resolvers"
tags: [hobo, design]
---

# ADR: Yard-first placement and primitive-scoped provider resolvers

## Status

Accepted (implemented)

## Context

HoBo topology primitives are Junction ⊃ Yard ⊃ Camp ⊃ Bindle deployment.
Earlier code incorrectly:

- required Camps to own Bindles and select providers
- derived Yard provider from member Camps
- required Yards to have at least one Camp
- allowed Bindle `.with({ provider })` pins to drive placement
- placed resources via a flat catalog match without selecting a Yard first

## Decision

1. **Yard owns provider selection.** `yard(name, { provider, camps? })` authors the provider; zero Camps are allowed (requested shape before live instance).
2. **Camp is provider-neutral** until attached to a Yard. Camps do not own Bindles. Provider is derived as `attachCampToYard` / placement evidence only.
3. **Bindle is provider-agnostic.** Cloud provider annotations and resolver pins on Bindles are rejected with `bindle-provider-selection-forbidden`.
4. **Deployment attaches Bindle → Yard** via `BindleDeploymentRequest` / `resolveBindleDeployment` (Yard-first path).
5. **Selection modes:** `exact` | `compatible` | `compatible-or-generate`. Exact never silently substitutes. Existing ready Yards always beat generation.
6. **Yard generation** is policy-gated (default **deny**), connector-backed, idempotent, and only selects the Yard after ready.
7. **Primitive resolvers** compose under the selected Yard provider (Yard → Camp → Bindle workload → resources). Bindles never contribute provider pins.
8. **No silent cross-Yard split.** Residuals resolve only under the selected Yard provider.

## Consequences

- Topology packages (`@hobo/yards`, `@hobo/camps`, `@hobo/bindles`) and `@hobo/broker` implement the production path.
- Embedded `hobo up` uses `resolveBindlePlacement` → `resolveBindleDeployment`.
- Multi-cloud means multiple provider-specific Yards under a Junction, not multi-provider pins in one Bindle/Camp.

## Event-store folds (provider resolvers)

Yard inventory and generation sagas are pure folds over the `yard.*` event family
(`yard.PlacementRequested` … `yard.PlacementResolved`).

Each provider registers a **primitive resolver** on slot `event-store`:

| Provider | Resolver ID | Role |
|----------|-------------|------|
| local | `local.yard.event-store/v1` | Zero-config component-host ready signals |
| azure | `azure.yard.event-store/v1` | ARM / ACA signal → yard.* |
| aws | `aws.yard.event-store/v1` | VPC / ECS signal → yard.* |
| gcp | `gcp.yard.event-store/v1` | VPC / Cloud Run signal → yard.* |

Provider packages export `normalize*YardSignal` + descriptors; the Broker fold
engine (`foldYardEventStore`) is provider-neutral. Connectors emit structured
progress; fold resolvers normalize into durable facts. Generation is
idempotent via `idempotencyKey` lease in the fold.
