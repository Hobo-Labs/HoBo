---
type: Reference
title: "Drift Reconciliation Scope And Acceptance"
description: "Source issue: HOBO-442."
tags: [hobo, design]
---

# Drift Reconciliation Scope And Acceptance

Source issue: HOBO-442.

Executable proof lives in
[`src/draft/exp-proofs/dx/drift-reconciliation-scope-contract`](../../src/draft/exp-proofs/dx/drift-reconciliation-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-442-drift-reconciliation`](./proofs/hobo-442-drift-reconciliation/README.md).

## M0 Acceptance Record

Drift Reconciliation defines the accepted boundary for comparing desired state, provider-observed
state, source-of-truth authority, reconciliation decisions, and owner handoffs. This M0 record names
the drift classes, reconciliation states, required evidence fields, owner dependencies, M1 proof
requirements, and follow-up gate before schema, state-machine, ResourceActor handoff, cleanup
handoff, support export, or provider refresh work can rely on it.

It does not build provider refresh schedulers, live provider polling, ResourceActor runtime changes,
autonomous remediation, real cloud mutation, destructive cleanup, support ticketing, billing
adjustment, or customer notification implementation.

## HoBo.CD: where drift runs

The M0 scope below assumed a reconciler that did not exist. HoBo.CD supplies it
([ADR-0180](./adr/01-architecture-core.md#adr-0180) D5, D22; [continuous-delivery.md](./continuous-delivery.md)):

- **Detection.** Every Camp has one fenced reconciler (per-Camp lease
  `cd:camp:<campId>`). It compares the Camp's desired Set with what it
  observes on the target and reports to the Camp's status stream
  (`deployment.StatusObserved`). Drift is a difference between the two, found
  by observation only.
- **Routing.** Drift on a field the Set owns is converged back by the same
  reconciler; a Camp in `OBSERVE_ONLY` management reports drift and never
  applies. Every change still goes through a Delta and the gate; nothing
  repairs a target outside its reconciler.
- **Retained fields are not drift.** Fields a target-side controller owns, such
  as autoscaler replica counts or provider-managed runtime versions, are
  declared (a resolver component's `describe`, the in-tree retained table, or
  the Camp mapping-rule property `hobo.cd/retain`) and reported as `retained`.
- **Posture.** A posture rule in `enforce` mode on a Set-owned field is drift
  by definition; on an unowned field it proposes a `posture-remediate` Delta
  ([governance-planes.md](./governance-planes.md)).
- **Runbook:** [reconcilers and drift](../runbooks/cd/reconcile.md).

## Scope

In scope:

- Drift classes: observed-state-diff, missing-provider-resource, extra-provider-resource,
  configuration-divergence, adopted-resource-drift, and stale-observation.
- Reconciliation states: detected, classified, source-of-truth-pinned, proposed, reconciling,
  ignored, escalated, and resolved.
- Required evidence: resource identity, desired-state reference, observed-state reference, source of
  truth, last refresh, policy decision, and support handoff.
- Boundaries for service, UX, security, and support owners.
- M1 evidence requirements and the follow-up issue gate.

Out of scope:

- Provider refresh scheduler, live provider API polling, provider adapters, or cloud observation
  runtime.
- ResourceActor runtime changes, reconcile command implementation, event-store projectors, or
  production read models.
- Autonomous remediation, self-healing, real cloud mutation, or drift repair workflow.
- Garbage sweeper, destructive cleanup, support ticketing, billing adjustment, or customer
  notification implementation.

## Dependencies

- [`control-plane.md#plan-04`](./control-plane.md#plan-04) for ResourceActor, desired-state,
  rollback, and reconciliation command ownership.
- [`reliability-observability-cost.md#plan-05`](./reliability-observability-cost.md#plan-05) for
  drift, refresh freshness, observability, and recovery signals.
- [`operators-sre.md#plan-40`](./operators-sre.md#plan-40) for SRE diagnosis and escalation.
- [`contracts-policy-flags.md#plan-29`](./contracts-policy-flags.md#plan-29) for policy decisions,
  deny posture, and mutation authorization.
- [`resource-garbage-collection.md`](./resource-garbage-collection.md) for extra-resource and
  missing-resource cleanup handoff boundaries.
- [`support-sla-channels.md`](./support-sla-channels.md) for support-safe explanation and handoff
  boundaries.
- [`ADR-0004`](./adr/01-architecture-core.md#adr-0004), [`ADR-0006`](./adr/01-architecture-core.md#adr-0006),
  [`ADR-0058`](./adr/03-data-plane.md#adr-0058), [`ADR-0094`](./adr/02-identity-security.md#adr-0094),
  and [`ADR-0041`](./adr/07-portability-extensibility.md#adr-0041).
