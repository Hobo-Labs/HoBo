# @hobo/testing PACT inventory

The harness boundary is in-process function calls, documented in HTTP shape so
it can be expressed as a pact. The interactions below are exercised against the
real implementation by the package's own vitest suites — there is no mock
harness, because a mocked test harness would be untestable in exactly the way
this package refuses to be.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| App test harness (deploy / fidelity / readiness) | hobo-bindle-test-suite | hobo-app-test-harness | in-process HTTP-shaped | `pacts/app-test-harness.pact.json` | `test/harness.test.ts`, `test/lanes.test.ts`, `test/readiness.test.ts` | none — the real harness runs | active |

## Refusal interactions

The house style is that a boundary documents how it says no. Three of the five
interactions are refusals:

- `HARNESS_YARD_REQUIRED` — the `ephemeral-camp` lane without a Yard. The
  refusal, not a downgrade to `in-process`, is the contract.
- `HARNESS_READINESS_REJECTED` — a deliberate 401 during readiness polling.
- `HARNESS_CREDENTIAL_NOT_A_REF` — a pasted credential value where a brokered
  `secretRef` locator belongs.

The two success interactions exist to pin the fidelity attestation: the deploy
response carries a per-label count and a teardown order, and the fidelity
response shows `prod_readiness_claimable: false` once an assertion has rested
on a `mocked` handle.
