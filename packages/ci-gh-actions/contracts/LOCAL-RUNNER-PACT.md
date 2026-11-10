# Local CI integration contracts and broker gate

The local runner lane uses Pact JS 17.1.4, its native Pact mock server/verifier,
and a real PostgreSQL-backed Pact Broker. Consumer tests generate the artifacts;
the owning provider's actual HTTP handler verifies them. Legacy hand-authored
contracts elsewhere in this folder keep their existing coverage and are not
implicitly broker-verified by this lane.

From the monorepo root, after the ordinary workspace install/build and pinned
act installation:

```sh
pnpm --filter @hobo/ci-gh-actions pact:up
pnpm --filter @hobo/ci-gh-actions test:pact
pnpm --filter @hobo/ci-gh-actions test:pact:broker --version "$(git rev-parse HEAD)" --branch local
pnpm --filter @hobo/ci-gh-actions pact:can-deploy --version "$(git rev-parse HEAD)"
```

`pact:up` waits for database and broker health. The broker binds to loopback port
9292; its database is not published. Images are digest-pinned, and its named
volume retains contract/version history across restarts. The fixed database
password is for this isolated local fixture only. Set `HOBO_PACT_BROKER_PORT`
and `PACT_BROKER_BASE_URL` together when changing the local port. To stop this
development broker without discarding history, use:

```sh
docker compose --project-name hobo-ci-pact -f packages/ci-gh-actions/contracts/compose.pact.yml down
```

An existing shared broker can replace the local broker through
`PACT_BROKER_BASE_URL=https://your-broker.example` and an approved
`PACT_BROKER_TOKEN` environment binding. Embedded URL credentials, plaintext
remote brokers, redirects, malformed responses and missing verification fail
closed. Use a reviewed source commit as `--version`. A published version cannot
be replaced with a different contract; publish the new source version instead.
GitHub's provider version is independent of HoBo's source commit. Select a
broker-verified upstream version with `--github-version <provider-version>` or
`HOBO_CI_GITHUB_PACT_VERSION`. Without one, the explicit `unverified` sentinel
keeps the release gate blocked. A legitimate independently published upstream
verification is honored; the validation lane never fabricates it.

## Scenario coverage

| Scenarios | Pact participant boundary | Execution |
| --- | --- | --- |
| Zero-budget admission, busy host, duplicate delivery, disabled/expired capacity | `HoboCiLocalWorkflowAcceptance` → `HoboCiLocalRelay` | Generated consumer Pact and actual relay HTTP verification |
| Public/fork/PR demand, revoked connection | Same | Independent provider states; no demand recorded after the tick |
| Valid JIT, disabled/expired/revoked authority, wrong host, repeated/completed claim | Same | Shipped `claimRunnerJit` consumer and actual relay HTTP verification |
| Repository/attempt/SHA/workflow identity mismatch, completed host, revoked original workflow | Same | Separate negative JIT provider states |
| Invalid identity, unknown lease, malformed/unsigned/bad-signature webhook, API outage, health and unknown route | Same | Status, response body and no-store headers verified |
| Repository visibility/rename/authentication/permissions, missing repository | `HoboCiLocalController` → `GitHubActionsRest` | Shipped GitHub CLI adapter against Pact's mock HTTP server |
| JIT success/refusal/422/503/missing credential/malformed response | Same | Exact API version, method, path, JSON body and parser behavior |
| Cleanup 204/404/403/503 | Same | Confirmed removal, idempotency and retained failure semantics |
| Missing auth/trust, idempotent starts, stop, damaged state, cancellation, pending/uncertain registration and cleanup retry | Native lifecycle prerequisites | Existing real subprocess/socket/process-group tests must pass before publication |
| Matrix/needs/outputs/artifacts/continued failures and provider swapping | Actual act corpus prerequisite | All 11 corpus scenarios execute; expected budget refusal launches no jobs |
| Two local jobs, capacity withdrawal, zero settlement and durable restart/replay | Connected acceptance prerequisite | Shipped relay/outbox/OIDC/JIT/host path with strict local remote fixtures |
| Missing JIT, wrong provider and skipped original job | Acceptance fault prerequisites | All three executions must fail |
| Missing/failed verification, version skew and changed contract under the same version | Real broker matrix and publication client | Missing/failed/skewed pairs block; immutable-version replacement is refused |
| Broker URL/credential/response guards and independent upstream version selection | Broker-client prerequisites | Real loopback client/CLI tests run before publication, including a mocked verified upstream version without publishing a fake GitHub result |

A signed delivery is committed to the relay's inbox and acknowledged before it
is admitted, so the HTTP answer of an admission interaction is `accepted`
(`ignored` when no connection binds the repository) and an outage of the GitHub
API no longer turns the delivery away. The admission decision of each state is
asserted after the relay's worker tick, in the provider state's teardown: one
dispatched `local` lease for an available or redelivered job, queued demand
and no lease for a busy, disabled or expired host, and no recorded demand for
public, fork, pull-request or revoked demand. A state handler that throws
fails the verification; Pact alone only logs it. Policy changes are stored
through the same rules a host applies: the store refuses to remove a connection
under an active lease, so the revoked claim state narrows the connection's
trusted branches instead.

The relay contract contains 31 separately generated interactions; the GitHub
consumer contract contains 16. Tests assert exact scenario inventories, so a
skipped or duplicated interaction fails. Pact handles protocol compatibility;
OS process lifecycle and executed workflow evidence remain explicit prerequisites.
The local acceptance consumer models synthetic webhook delivery and invokes the
shipped bootstrap client for JIT claims. It does not represent a contract
authored or verified by GitHub.

## What the broker approves

`test:pact:broker` is a validation lane. It first executes the native and workflow
prerequisites, then publishes both consumer contracts and their branch/version
metadata. It fetches the exact relay contract back from the broker for provider
verification, publishes that result, and queries exact-version compatibility.
An intentionally broken provider uses a separate negative-control version and
branch. Its failed verification must appear in the broker matrix; an absent
result is insufficient to pass that test. Evidence, generated Pacts and the
matrix report live under ignored `.hobo/ci-local/pact-evidence/` unless
`--evidence` specifies another directory.

The GitHub CLI fixture only translates the real adapter's arguments/stdin to
Pact's loopback mock HTTP server. It does not authenticate or contact GitHub.
No successful provider verification is published for `GitHubActionsRest`.
Consequently **`pact:can-deploy` currently blocks** this unverified external
integration, even when HoBo's owned relay contract is green. This is deliberate:
passing local consumer tests is not evidence of GitHub accepting the contract.
The lane does not establish live GitHub queue assignment or vendor runner
compatibility. These remain visible unknowns, not synthetic success.

The verifier worker only fetches contracts from the configured broker. Pact JS's
Node proxy currently ignores `NO_PROXY`; this isolated worker routes its local
provider directly and preserves remote broker proxy access through `ALL_PROXY`.
Normal runtime proxy/credential configuration is unchanged.

TypeScript checks the consumer/provider harness and scripts. Existing Protobuf
and CUE gates protect the offer, policy and JIT response families. The broker
client parses untrusted matrix results with Zod; its private evidence report is
operational test output rather than a new application event or public DTO.
