---
type: Reference
title: "Resource Garbage Collection Scope And Acceptance"
description: "Source issue: HOBO-443."
tags: [hobo, design]
---

# Resource Garbage Collection Scope And Acceptance

Source issue: HOBO-443.

Executable proof lives in
[`src/draft/exp-proofs/dx/resource-garbage-collection-scope-acceptance`](../../src/draft/exp-proofs/dx/resource-garbage-collection-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-443-resource-garbage-collection`](./proofs/hobo-443-resource-garbage-collection/README.md).

## M0 Acceptance Record

Resource Garbage Collection defines the safe cleanup boundary for orphan inventories, cleanup
eligibility, support handoff, and later sweeper proof. This M0 record names the garbage classes,
cleanup states, required evidence fields, owner handoffs, and follow-up gate before schema,
state-machine, policy, drift-handoff, support, or provider sweeper issues can rely on it.

It does not build provider adapters, live sweepers, destructive cleanup runtime, drift detection,
rollback compensation, legal retention policy, billing, support ticketing, or customer notification
implementation.

## Scope

In scope:

- Garbage classes: created-but-not-in-state, destroyed-in-state-but-live, deprecated generated
  artifacts, expired preview resources, and failed-cleanup residue.
- Cleanup states: suspected, inventoried, quarantined, eligible, swept, and escalated.
- Required evidence: owner, resource identity, source of truth, last observed signal, eligibility
  decision, policy window, and support handoff.
- Boundaries for service, UX, security, and support owners.
- M1 evidence requirements and the follow-up issue gate.

Out of scope:

- Provider adapter sweepers, real cloud deletes, production cleanup daemon, or live resource mutation.
- Replacement for drift detection, ResourceActor reconciliation, partial-apply compensation, or
  provider refresh fidelity.
- Legal retention policy, customer data deletion policy, billing, chargeback, or tax behavior.
- Support desk workflow, ticketing integration, incident automation, or customer notification
  implementation.

## Dependencies

- [`control-plane.md#plan-04`](./control-plane.md#plan-04) for ResourceActor, rollback, and state
  ownership.
- [`reliability-observability-cost.md#plan-05`](./reliability-observability-cost.md#plan-05) for
  drift, observability, and recovery signals.
- [`operators-sre.md#plan-40`](./operators-sre.md#plan-40) for SRE diagnosis and escalation.
- [`contracts-policy-flags.md#plan-29`](./contracts-policy-flags.md#plan-29) for policy gates and
  destructive-action obligations.
- [`support-sla-channels.md`](./support-sla-channels.md) for support handoff boundaries.
- [`ADR-0006`](./adr/01-architecture-core.md#adr-0006), [`ADR-0004`](./adr/01-architecture-core.md#adr-0004),
  [`ADR-0058`](./adr/03-data-plane.md#adr-0058), [`ADR-0094`](./adr/02-identity-security.md#adr-0094),
  and [`ADR-0041`](./adr/07-portability-extensibility.md#adr-0041).
