# @hobo/contracts — contract evidence

Executable PACT boundaries for the Contract IR + can-deploy engine + the composed
Gatekeeper, lifted from the contracts-policy-governance epic proof
([`src/draft/epic-proofs/contracts-policy-governance`](../../../src/draft/epic-proofs/contracts-policy-governance)):

- `pacts/gatekeeper-contract-engine.json` — the Gatekeeper asks the contract
  engine for a `can-deploy` verdict before deciding.
- `pacts/gatekeeper-policy-engine.json` — the Gatekeeper runs the built-in
  policy engine and receives an effect + evidence + obligations.
- `pacts/gatekeeper-obligation-engine.json` — obligations are started/replayed
  and the gate is not blocked once satisfied.
- `pacts/gatekeeper-cost-quota.json` — the deployment quota is checked before a
  prod promotion.
- `pacts/contract-engine-deployed-state.json` — the contract engine reads the
  running producer/consumer versions it builds the matrix from.
- `pacts/policy-engine-audit-log.json` — every decision appends a
  `policy.Decided` fact to the audit log.

`consumer/gatekeeper-boundaries.test.ts` drives the **real** `@hobo/contracts`
engines (`evaluateCanDeploy`, `evaluatePolicyPack`, `evaluateGatekeeper`) against
each recorded interaction, asserting the package satisfies its consumer
contracts.
