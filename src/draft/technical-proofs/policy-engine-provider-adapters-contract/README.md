# Policy Engine Provider Adapters Contract POC

This draft proves HOBO-223's optional OPA/Rego and Cedar policy-engine provider adapter boundary.

It consumes the HOBO-91 policy IR, HOBO-100 policy-engine port, HOBO-128 deny-ceiling algebra, and
HOBO-133 built-in policy engine artifacts, then records:

- OPA/Rego mapping from `DecisionRequest` to canonical policy input.
- Cedar ABAC mapping from the same `DecisionRequest` into principal/action/resource/context.
- Provider adapters with stable `evidence.engine` identities.
- A shared conformance suite that runs the built-in engine, OPA/Rego adapter, and Cedar adapter
  against the same vectors.
- Deny-by-default behavior for unmapped tuples and actions.
- Deny-ceiling composition before adapter policy evaluation.
- Fail-closed handling for Rego/Cedar policy errors.
- Determinism detection for adapters that return ambient or unstable decisions.

## Boundary

This POC does not author real Rego or Cedar policy bundles, embed external OPA/Cedar runtimes, change
the HOBO-100 conformance port definition, or alter the HOBO-128 deny-ceiling algebra.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/policy-engine-provider-adapters-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Policy Engine Provider Adapters Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
