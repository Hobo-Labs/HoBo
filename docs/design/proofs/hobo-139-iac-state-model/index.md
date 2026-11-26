# HOBO-139 Per-Resource IaC State Model Proof

This proof backs [PLAN-25](../../platform-engineering.md#plan-25) and
[ADR-0006](../../adr/01-architecture-core.md#adr-0006).

The executable POC in
[`src/draft/technical-proofs/iac-state-model-contract`](../../../../src/draft/technical-proofs/iac-state-model-contract)
proves the M1 IaC state model boundary:

- stack keys are isolated by `tenant/deployment/resource`;
- destroying one resource leaves sibling resource state intact;
- stack outputs are captured into `resource.Provisioned` and resolved into dependent binding refs;
- ActorHost single-writer leases reject concurrent writers even when a backend lock is lost;
- orphaned stacks after a crashed apply remain visible for reconciliation;
- output-key collisions fail closed;
- state-backend unavailability fails the apply before a provisioned fact is emitted.

Scope kept out: drift reconciliation, ActorHost implementation, adopt-in-place import, cross-resource
DAG ordering, and real cloud/IaC adapter behavior.
