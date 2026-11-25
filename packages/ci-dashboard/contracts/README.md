# @hobo/ci-dashboard contracts

`read-api.pact.json` is the boundary between the dashboard (the consumer,
`HoBoCiDashboard`) and the relay's read API (the provider,
`HoBoCiRelayReadApi`, `packages/ci-gh-actions/src/read-api.ts`).

Each interaction is one request the dashboard makes, exactly as it makes it:
the path, the query (`repository`, `limit`) and the account token. Its
response is the one the provider's own pact
(`packages/ci-gh-actions/contracts/read-api.pact.json`) gives for that path
and token, which `read-api.provider.test.ts` there verifies against the real
read API. It covers:

1. **The five views**: `/machines` and `/routes` (Runners), `/runner-order`,
   `/routes` and `/machines` (Router), `/runs` and
   `/runs/{id}/{attempt}/jobs` (History), `/job-times` (Performance) and
   `/signals` (Signals).
2. **Refusals**: a token without `policy:read` (403), another account's
   repository (404 `not-found`), and a host that keeps no run history (404
   `not-stored-here` naming the command that reads GitHub instead).

`test/read-api.pact.test.ts` drives the views and the refusals through
`DashboardReadApi` against a mock built from the provider's pact, fails if
any request falls outside it or is not a `GET`, and fails if this file
differs from what the dashboard sends. `UPDATE_PACT=1` rewrites it.

The account-wide `/routes` read of the Runners view (no `repository`) is
answered from the provider's one-repository interaction; the provider pact
has no account-wide `/routes` interaction of its own.
