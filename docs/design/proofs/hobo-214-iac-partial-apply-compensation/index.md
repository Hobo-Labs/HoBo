# HOBO-214 IaC Partial Apply Compensation Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-09](../../generated-stack.md#plan-09),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0006](../../adr/01-architecture-core.md#adr-0006).

The executable POC in
[`src/draft/technical-proofs/iac-partial-apply-compensation-contract`](../../../../src/draft/technical-proofs/iac-partial-apply-compensation-contract)
proves the M3 provider/IaC partial-apply boundary:

- `iac-pulumi` and `iac-opentofu` fixture backends both leave recoverable
  per-resource state after mid-program failure;
- `destroy()` removes exactly the recorded partial resources plus tagged
  created-before-state-write orphans for one stack key;
- retried `apply()` adopts tagged orphans and converges without duplicate
  infrastructure;
- retryable/fatal apply classifications are surfaced with backend, stack, and
  logical resource precision;
- a no-go-threshold fixture compensation leaves zero residue;
- destroy failure during compensation escalates with the remaining residue;
- false provider success that does not match reality is treated as fatal.

Scope kept out: the Orchestrator saga engine, reverse-dependency DAG traversal,
ResourceActor FSM implementation, production Pulumi/OpenTofu adapters, and drift
detection.
