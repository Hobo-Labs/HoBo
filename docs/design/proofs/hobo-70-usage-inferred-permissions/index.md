# HOBO-70 Usage-Inferred Permissions Proof

This proof backs [PLAN-21](../../authoring-resources-wiring.md#plan-21),
[PLAN-29](../../contracts-policy-flags.md#plan-29), and
[ADR-0069](../../adr/01-architecture-core.md#adr-0069).

The executable POC in
[`src/draft/technical-proofs/usage-inferred-permissions-contract`](../../../../src/draft/technical-proofs/usage-inferred-permissions-contract)
and the consolidated S1-17 draft at
[`src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc`](../../../../src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc)
(HOBO-607) prove the M2 authoring permission boundary:

- resource calls lower to a least-privilege manifest `allow` set;
- wasm capability `links` carry the same granted verb set as the manifest `allow` entries;
- `.allow(...)` caps grants to the declared narrow set and records the capability contract marker;
- narrowing below observed usage records a `capability.required-not-granted` failure for `can-deploy`
  to consume;
- deny-by-default holds for uncalled verbs, including helper-mediated calls;
- dynamic grants are marked with `declared-dynamic` provenance; and
- unmarked `.allow()` widening beyond usage fails closed.

Scope kept out: wasm host enforcement, IAM generation, agent-token scoping, static-analysis
coverage, and the `can-deploy` gate implementation.
