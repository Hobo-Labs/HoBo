Executable PACT consumer evidence for `@hobo/dispatcher` library boundaries.

| Pact | Boundary |
|---|---|
| [`pacts/dispatch_decision.pact.json`](./pacts/dispatch_decision.pact.json) | Broker/stations dispatch-decision v1 boundary |
| [`pacts/dispatch_decision_v2.pact.json`](./pacts/dispatch_decision_v2.pact.json) | Pricing-backed minimum-incremental-billed dispatch v2 boundary, including stale-evidence rejection |

The v1 synchronous-message contract supplies registry candidates and the ledger
snapshot used by `createDispatcherRegistry` and `decideDispatch`. Its tests run
each recorded request through those functions, including budget pressure and
the all-ineligible hard-budget result. Refusal carries no `dispatch.Decided`
fact. These expectations do not prove provider billing behavior. Reservation
finance, running-hold retention and snapshot retry invariants are exercised by
`test/budget-safety.test.ts`.

Run consumer tests:

```sh
pnpm --filter @hobo/dispatcher test:contract:consumer
```
