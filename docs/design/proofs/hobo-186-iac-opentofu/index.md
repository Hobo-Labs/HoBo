# HOBO-186 OpenTofu IaC Backend Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04) and
[ADR-0041](../../adr/07-portability-extensibility.md#adr-0041).

The executable POC in
[`src/draft/technical-proofs/iac-opentofu-backend-contract`](../../../../src/draft/technical-proofs/iac-opentofu-backend-contract)
proves the M2 OpenTofu backend contract:

- the OpenTofu adapter consumes the same fixture resource shape used by the
  `iac-pulumi` proof;
- preview, apply, refresh, and destroy flow through one `IacProvider` adapter
  interface and return typed diff/output/drift shapes;
- the fixture passes an `@hobo/conformance/iac-backend` proof;
- the OpenTofu binary version is pinned;
- unsupported HCL mappings, state-lock contention, binary plan skew, and
  partial apply fail closed.

Scope kept out: the production OpenTofu shell wrapper, real HCL generation,
provider adapters, Crossplane/Pulumi/CDKTF behavior, and compensation for
partial apply. Partial apply is surfaced as drift for the dedicated adversarial
slice to compensate.
