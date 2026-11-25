# HOBO-123 Can-Deploy Compatibility Proof

This proof backs [PLAN-29](../../contracts-policy-flags.md#plan-29) and
[ADR-0015](../../adr/02-identity-security.md#adr-0015).

The executable POC in
[`src/draft/technical-proofs/can-deploy-compatibility-gate-contract`](../../../../src/draft/technical-proofs/can-deploy-compatibility-gate-contract)
proves the M1 compatibility-matrix gate:

- producer removals that break still-running consumers emit `compat.GateFailed`
  with precise missing fields and suggested fixes;
- compatible additive producer changes emit `compat.GatePassed`;
- proposed consumers that require fields missing from already-running producers
  are blocked;
- missing target running-version facts fail closed;
- `record-and-verify` is recorded as Camp mode but never weakens strict
  compatibility semantics;
- gate decisions replay from `compat.Gate*` events;
- the draft `hobo can-deploy --target` entry point returns the structured
  decision and exit code.

Out of scope: observed-contract mining and promotion windows, the full
Gatekeeper composition, policy/eval/cost gates, and Contract IR / contract-engine
definition work from HOBO-116 and HOBO-119.
