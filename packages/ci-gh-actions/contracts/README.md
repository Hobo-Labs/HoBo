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

Every provider test here runs the one relay core (`HostedRelay`, its runtime,
`createHostedControlPlane` and the shared HTTP handler) over `SqliteCiStore`;
there is no second relay implementation behind any of these artifacts.

The Pact artifacts in this directory are hand-authored boundary expectations.
Consumer tests exercise shipped code with strict injected remote responses;
provider tests exercise the relay over real loopback HTTP. They do not claim
GitHub or vendor verification, a published Pact broker, or a live runner pass.

| Artifact | Executed boundary |
| --- | --- |
| `github-app-boundary.pact.json` | Signed App JWT exchange, installation credentials, dispatch and JIT registration, error and redirect handling |
| `relay-boundary.pact.json` | Signed webhook intake into the inbox, then the tick's reservation and dispatch, and single-use authenticated JIT claims |
| `http-boundary.pact.json` | The shared Fetch handler behind the Node adapter: committed and duplicate deliveries, an unsigned delivery, readiness with its engine map, and the JIT claim envelope. Every host of the relay serves this handler |
| `mcp-boundary.pact.json` | The MCP server at `/mcp` without sessions, as every host serves it: credential, scope and origin refusals, initialize without subscriptions, the tool and resource lists, an event read after a cursor, a wait that ends without news, queued jobs, status with its limits, the mesh's node list and resource answering `mesh: "not-configured"` on a host with no mesh, a write refused for want of `operations:write`, a lease the account does not own reported as absent, a cursor not issued to the account refused as invalid input, and a request refused for carrying too many messages |
| `onboarding-boundary.pact.json` | App/installation/repository discovery, reviewed setup branch and pull request, merged-source verification and protected bridge connection |
| `control-plane-boundary.pact.json` | Account authentication and scopes, revisioned policy (including the full-account update a self-hosted relay enables), stored setup operations, lease reconciliation, and the mesh node list (`GET /v1/mesh/nodes`): refused without a credential, and `mesh: "not-configured"` on a relay with no mesh |
| `scoped-budget-signals.pact.json` | Current-period reset, crossing, recovery, ordered replay, and refusal of foreign-period or legacy recovery facts over local HTTP |
| `service-boundary.pact.json` | Service readiness, and refusal of an authentic delivery while the Node host is not ready, over HTTP |
| `actions-backend.pact.json` | Portable pipeline execution through the Actions backend |

`control-plane-client.consumer.test.ts` checks the typed SDK against applicable
control-plane interactions and separately tests its remaining methods, strict
protobuf wire parsing, credential handling and error behavior.
`backend-swap.consumer.test.ts` runs the same portable pipeline cases through
Actions, Dagger and Cloudflare implementations. Negative wire cases stay in the
owning HTTP provider tests; client coverage does not fabricate requests for
payloads its API cannot express.
`../test/scoped-budget-signals.test.ts` executes every scoped signal interaction
against the shipped local control plane and separately exercises its typed client
with actual Broker fold output. Provider billing and native spending bounds are
outside this contract.

Run the owning package suite from the monorepo root:

```sh
pnpm --filter @hobo/ci-gh-actions test
```

The owning Vitest configuration honors `HOBO_TEST_TIMEOUT` for test and hook
budgets (10 seconds by default). The native GitHub CLI Pact sequence keeps its
30-second default and honors the same override when workspace builds contend for
CPU; final gates use `HOBO_TEST_TIMEOUT=60000`. This changes only the test harness
budget: provider operation deadlines and CLI subprocess guards remain enforced.

The [connected acceptance lane](../acceptance/README.md) additionally runs the
shipped service, automatic worker, SQLite journal, OIDC/JWKS validation, JIT
claim, host process and actual `act` jobs. A strict local remote boundary supplies
provider APIs. It verifies zero-cost routing, paid-price selection, provider
and account budgets, replay and restart. Live GitHub queue consumption and nested
runner compatibility on vendor machines require execution evidence from those
machines.
