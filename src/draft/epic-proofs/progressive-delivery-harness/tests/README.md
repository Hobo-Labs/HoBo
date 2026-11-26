# Tests

`harness-reference.test.ts` verifies:

- The healthy progressive-delivery vertical slice.
- SLO-burn auto rollback.
- Stale ruleset and underpowered experiment fail-closed behavior.
- Stuck rollout and rollback-compensation escalation.
- Pact-style contract files for every mocked boundary.
