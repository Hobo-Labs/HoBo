# HOBO-223 Policy Engine Provider Adapters Proof

This proof makes the Plan 29 OPA/Rego and Cedar policy-engine provider adapters executable in
[`src/draft/technical-proofs/policy-engine-provider-adapters-contract`](../../../../src/draft/technical-proofs/policy-engine-provider-adapters-contract/README.md).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Both adapters pass identical conformance suite the built-in engine passes | `OPA/Rego and Cedar adapters pass the same conformance suite as the built-in engine` |
| Deny-by-default holds via OPA/Cedar too | `deny-by-default and evidence.engine hold for both provider adapters` |
| Deny-ceiling composition semantics same effective deny-set as built-in on shared fixture | `deny-ceiling composition produces the same effective deny as built-in` |
| `evidence.engine` identifies adapter | `deny-by-default and evidence.engine hold for both provider adapters` |
| Adapter returning allow for unmapped action fails conformance | `adapter returning allow for an unmapped action fails conformance` |
| Adapter must not un-deny mandatory deny-ceiling | `lower-scope adapter allow cannot un-deny a mandatory deny-ceiling` |
| Non-deterministic adapter result fails conformance | `non-deterministic adapter result fails conformance` |
| Rego/Cedar policy error fails closed | `Rego and Cedar policy errors fail closed` |

## Boundary

This is only the provider adapter and conformance parity slice. Real Rego/Cedar policy authoring,
external runtime embedding, policy-engine port definition, built-in engine implementation, and
deny-ceiling algebra remain owned by their separate issues.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/policy-engine-provider-adapters-contract test
```
