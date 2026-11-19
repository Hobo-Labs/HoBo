Executable PACT consumer evidence for `@hobo/dispatcher` library boundaries.

| Pact | Boundary |
|---|---|
| [`pacts/dispatch_decision.pact.json`](./pacts/dispatch_decision.pact.json) | Broker/stations credit-based dispatch boundary |
| [`pacts/priced_dispatch_decision.pact.json`](./pacts/priced_dispatch_decision.pact.json) | Pricing-backed minimum-incremental-billed dispatch boundary, including stale-evidence rejection |

The credit-based synchronous-message contract supplies registry candidates and the ledger
snapshot used by `createDispatcherRegistry` and `decideCreditDispatch`. Its tests run
each recorded request through those functions, including budget pressure and
the all-ineligible hard-budget result. Refusal carries no `dispatch.Decided`
fact. These expectations do not prove provider billing behavior. Reservation
finance, running-hold retention and snapshot retry invariants are exercised by
`test/budget-safety.test.ts`.

Run consumer tests:

```sh
pnpm --filter @hobo/dispatcher test:contract:consumer
```
