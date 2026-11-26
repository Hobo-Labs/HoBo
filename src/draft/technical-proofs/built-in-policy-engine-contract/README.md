# Built-In Policy Engine Contract POC

This draft proves HOBO-133's built-in, deny-by-default policy engine boundary.

It consumes the HOBO-91 policy IR and HOBO-128 deny-ceiling algebra artifacts, then records:

- Typed TypeScript policy rules over `DecisionRequest`.
- Yard-local evaluation through `createBuiltInPolicyEngine().executionMode`.
- Deny-by-default behavior for unmapped tuples and actions.
- Deny-ceiling composition before rule execution.
- Deny-overrides reduction across matched TypeScript rules.
- Fail-closed handling for rule exceptions.
- Deterministic `Decision.evidence` with `policyIds`, `inputHash`, and `engine`.
- Async `policy.Decided` audit emission.

## Boundary

This POC does not implement OPA/Cedar adapters, pack signing, obligation execution, composition
algebra design, or OCSF export.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/built-in-policy-engine-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Built In Policy Engine Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
