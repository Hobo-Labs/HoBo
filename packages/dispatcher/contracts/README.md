Executable PACT consumer evidence for `@hobo/dispatcher` service boundaries.

| Pact | Boundary |
|---|---|
| [`pacts/dispatch_decision.pact.json`](./pacts/dispatch_decision.pact.json) | Broker/stations dispatch-decision v1 boundary |
| [`pacts/dispatch_decision_v2.pact.json`](./pacts/dispatch_decision_v2.pact.json) | Pricing-backed minimum-incremental-billed dispatch v2 boundary, including stale-evidence rejection |

Run consumer tests:

```sh
pnpm --filter @hobo/dispatcher test:contract:consumer
```
