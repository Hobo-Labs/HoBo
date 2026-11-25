# @hobo/testing PACT inventory

The harness boundary is in-process function calls, documented in HTTP shape so
it can be expressed as a pact. The interactions below are exercised against the
real implementation by the package's own vitest suites — there is no mock
harness, because a mocked test harness would be untestable in exactly the way
this package refuses to be.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| App test harness (deploy / fidelity / readiness) | HoboBindleTestSuite | HoboAppTestHarness | in-process HTTP-shaped | `pacts/app-test-harness.pact.json` | `test/app-harness.pact.test.ts` adapts the real harness functions | fixture graph and synthetic readiness probe | provider_verified |
| Queue, topic, secret, data, schedule, key-value, bucket and flag emulator access | HoboApplicationTestSuite | HoboServiceEmulators | in-process HTTP-shaped | `pacts/service-emulators.pact.json` | `test/service-emulators.pact.test.ts` executes the actual harness | none | provider_verified |

## Refusal interactions

The house style is that a boundary documents how it says no. Three of the five
interactions are refusals:

- `HARNESS_YARD_REQUIRED` — the `ephemeral-camp` lane without a Yard. The
  refusal, not a downgrade to `in-process`, is the contract.
- `HARNESS_READINESS_REJECTED` — a deliberate 401 during readiness polling.
- `HARNESS_CREDENTIAL_NOT_A_REF` — a pasted credential value where a brokered
  `secretRef` locator belongs.

The two success interactions pin the fidelity report: the deploy response
captures the initial per-label counts and planned teardown order before any
handles are accessed. Neither handle access nor an in-process deployment
claims production readiness. Separate lifecycle tests verify resource cleanup.

The emulator pact pins observable port behavior and a wrong-kind refusal, not a
cloud provider's behavior. The queue also reuses the runtime-local queue/clock
pact; topic delivery and failure behavior use the executable Messaging
conformance suite. No production-provider verification is implied.
