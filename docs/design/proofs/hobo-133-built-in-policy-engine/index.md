# HOBO-133 Built-In Policy Engine Proof

This proof makes the Plan 29 built-in, deny-by-default policy engine executable in
[`src/draft/technical-proofs/built-in-policy-engine-contract`](../../../../src/draft/technical-proofs/built-in-policy-engine-contract/README.md).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Ruleset + request fixtures produce expected effect | `ruleset and request fixtures produce an allow decision with deterministic evidence` |
| Unlisted tuple denies | `unlisted tuple and action deny by default rather than warning` |
| Composed deny-ceiling cannot be widened by lower-scope rule | `composed deny-ceiling denies cannot be widened by lower-scope allows` |
| Evidence populated and decision deterministic | `ruleset and request fixtures produce an allow decision with deterministic evidence` |
| Same engine runs identically given same inputs | `evaluation does not depend on rule registration order` |
| Rule that throws fails closed deny | `rule exceptions fail closed deny with evidence from the throwing rule` |
| Action with no mapped rule denies, not warns | `unlisted tuple and action deny by default rather than warning` |
| Lower-scope pack cannot grant past mandatory deny | `mandatory deny-ceiling overrides matching TypeScript allow rules` |
| Evaluation does not depend on rule registration order | `evaluation does not depend on rule registration order` |

## Boundary

This is only the built-in TypeScript policy engine slice. OPA/Cedar adapters, pack signing,
obligation execution, deny-ceiling algebra design, and OCSF export remain out of scope.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/built-in-policy-engine-contract test
```
