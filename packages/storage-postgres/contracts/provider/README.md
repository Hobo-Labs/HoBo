# Contracts — eventstore boundary

`../eventstore-boundary.pact.json` is the PACT between the CD reconciler
transport (consumer `hobo-cd-reconciler`) and this store
(provider `hobo-storage-postgres`).

- Consumer evidence: `../consumer/eventstore-boundary.test.ts`. Every expected
  failure code is one the reconciler classifies (lost lease, retry, or
  regression) rather than an outage. Positions and fences are decimal strings.
- Provider verification: `eventstore-boundary.provider.test.ts` arranges each
  `providerState` on a real PostgreSQL store and replays the request
  (`test:contract:provider`). It runs on the live lane and is skipped, with
  the reason in its name, when no server is available.

## Runbook

When the provider verification fails, the store changed an observable code or
shape that the reconciler depends on. Fix the store, or change the pact with
the consumer owner. Never change only one side.
