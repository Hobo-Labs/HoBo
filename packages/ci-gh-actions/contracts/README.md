# HoBo CI GitHub Actions contract coverage

Digest-pinned container images for the Pact Broker lane live in
[`pinned-container-images.json`](pinned-container-images.json) (shared with
[`compose.pact.yml`](compose.pact.yml) and
[`test/pinned-postgres-testcontainers.test.ts`](../test/pinned-postgres-testcontainers.test.ts)).
Production relay images are built from
[`../deploy/Dockerfile`](../deploy/Dockerfile) (multi-stage, non-root `1000:1000`).

The [local runner Pact Broker lane](LOCAL-RUNNER-PACT.md) adds generated Pact
consumer contracts, native provider verification, real broker publication and
version-matrix gates for local CI. It explicitly retains unverified GitHub
provider status. The legacy artifacts below have their existing local coverage.

The Pact artifacts in this directory are hand-authored boundary expectations.
Consumer tests exercise shipped code with strict injected remote responses;
provider tests exercise the relay over real loopback HTTP. They do not claim
GitHub or vendor verification, a published Pact broker, or a live runner pass.

| Artifact | Executed boundary |
| --- | --- |
| `github-app-boundary.pact.json` | Signed App JWT exchange, installation credentials, dispatch and JIT registration, error and redirect handling |
| `relay-boundary.pact.json` | Signed webhook intake and single-use authenticated JIT claims |
| `onboarding-boundary.pact.json` | App/installation/repository discovery, reviewed setup branch and pull request, merged-source verification and protected bridge connection |
| `control-plane-boundary.pact.json` | Account authentication and scopes, revisioned policy, stored setup operations and lease reconciliation |
| `service-boundary.pact.json` | Service readiness and admission over HTTP |
| `actions-backend.pact.json` | Portable pipeline execution through the Actions backend |

`control-plane-client.consumer.test.ts` checks the typed SDK against applicable
control-plane interactions and separately tests its remaining methods, strict
protobuf wire parsing, credential handling and error behavior.
`backend-swap.consumer.test.ts` runs the same portable pipeline cases through
Actions, Dagger and Cloudflare implementations. Negative wire cases stay in the
owning HTTP provider tests; client coverage does not fabricate requests for
payloads its API cannot express.

Run the owning package suite from the monorepo root:

```sh
pnpm --filter @hobo/ci-gh-actions test
```

The [connected acceptance lane](../acceptance/README.md) additionally runs the
shipped service, automatic worker, SQLite journal, OIDC/JWKS validation, JIT
claim, host process and actual `act` jobs. A strict local remote boundary supplies
provider APIs. It verifies zero-cost routing, paid-price selection, provider
and account budgets, replay and restart. Live GitHub queue consumption and nested
runner compatibility on vendor machines require execution evidence from those
machines.
