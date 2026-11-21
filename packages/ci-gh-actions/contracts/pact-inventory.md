# GitHub Actions boundary inventory

## Runner service boundary

`github-runner-service.pact.json` records hand-authored consumer expectations
for the runner service. `../test/runner-protocol-pact.test.ts` executes them
against the client with injected fixture responses. This is not provider-verified
by GitHub, published to a Pact broker, or evidence of a live runner session.

## GitHub App boundary

The [local runner broker inventory](LOCAL-RUNNER-PACT.md) covers the generated
31-interaction relay Pact and 16-interaction GitHub CLI consumer Pact, including
real broker publication, provider verification and failure/version gates. The
legacy GitHub App artifact described below remains a separate local fixture.

`github-app-boundary.pact.json` contains **hand-authored consumer expectations**.
It is neither captured provider traffic nor a GitHub-verified contract. Its
participant names and request/response envelopes follow Pact specification
3.0.0. No Pact broker publication or remote provider verification is claimed.

`github-app.consumer.test.ts` reads this artifact and drives the shipped
`createGithubAppTransport` with an injected Fetch implementation. API fixtures
come from the artifact. Tests generate an ephemeral RSA key pair and verify the
actual App JWT signature, issuer, timestamps, and header before returning the
fixture installation token. Both credentialed requests assert the pinned
`2026-03-10` API version, headers, paths, methods, exact body bytes, redirect
policy, and timeout signal. Every interaction must execute.

| Boundary | Expectations exercised | Evidence |
| --- | --- | --- |
| App authentication | Signed JWT exchange, installation token, 401, empty-token refusal | Mocked consumer test |
| Workflow dispatch | Branch/tag bridge ref, exact provider inputs, empty 204, 403 propagation | Mocked consumer test |
| Repository JIT runner | `hobo` label, runner name/group/work folder, 201 payload, 422 propagation | Mocked consumer test |
| Credential redirect | `redirect: error` on exchange and API requests; modeled Fetch rejection with no second destination | Mocked consumer test |
| Conditional read | `If-None-Match` sent on a GET and its 304 returned to the caller; never sent on a write | Mocked consumer test |
| API path guard | Absolute URL, traversal, and encoded separator rejected before Fetch | Local consumer test |

The redirect stub models Fetch rejecting a 301, 302, 303, 307 or 308 when `redirect` is `error`;
it does not claim a live HTTP redirect experiment. Test assertions are exercised
through the transport directly, outside the relay's deliberate catch-and-retain
handlers, so contract mismatches cannot become successful uncertainty tests.

The relay lifecycle suite separately exercises budget reservations, webhook
intake, host identity checks, and recovery with injected dependencies. This
artifact does not establish live workflow dispatch, vendor acceptance of nested
runners, JIT execution, provider pricing, or billing accuracy. Repository/run/job reads and webhook delivery are covered by the local relay
protocol and HTTP contracts. The connected acceptance lane verifies RS256/JWKS
against a locally served keyset. See [the current inventory](README.md) for the
onboarding, control-plane, client and service boundaries; none is remote
GitHub or vendor verification.

Run the package test command or target
`contracts/github-app.consumer.test.ts` with Vitest. No live credentials or
external API access is required.

Official references: [App installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app),
[workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
and [repository JIT runner configuration](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository).

Relay HTTP provider boundary: `relay-boundary.pact.json` is exercised by
`relay.provider.test.ts` over real loopback HTTP with simulated GitHub/identity
ports, through the shared HTTP handler and Node adapter. It verifies all
declared interactions, then that the worker tick reserves and dispatches the
committed delivery, JIT authorization and single-use claims. This is local provider verification against mocks, not a live integration.

Relay MCP provider boundary: `mcp-boundary.pact.json` is exercised by
`mcp-boundary.provider.test.ts` over real loopback HTTP, through the shared
HTTP handler and Node adapter, against `SqliteCiStore` with one account and
one queued job. It is a hand-authored consumer expectation of 18 interactions
in the sessionless JSON form every host serves; the provider may answer more
than a consumer names, so bodies are matched as subsets. A cursor's value is
not pinned, since it is a token issued per account; the provider test checks
that every cursor in an answer has a token's form and is not a number. Its two bearer values
are fixture strings the test binds to a test account; they are not credentials
for anything. Sessions, streams and resource subscriptions are covered by
`../test/relay-mcp.test.ts` with the SDK's client, not by this artifact, and no
third-party MCP client is claimed as verified.

Relay job facts boundary: `relay-job-facts.pact.json` holds hand-authored
consumer expectations of the GitHub REST reads a relay job makes with its own
token in job mode: the routing slip ref (present and missing), its commit, the
run list and one run's jobs. `relay-job-facts.consumer.test.ts` drives
`GithubRouteFacts` through every interaction with an injected Fetch. No
provider verification or live GitHub call is claimed.

Machine worker GitHub boundary: `github-machine-worker.pact.json` holds
hand-authored consumer expectations of the REST requests `hobo ci machine
connect` sends with its owner's own token: the signed-in user (and a revoked
token's 401), whether a repository is private, its queued and in-progress
runs, a run's latest jobs (one run from the repository, one from a fork),
a one-job runner made with the machine's label (and the 403 a non-admin gets),
and the removal of a runner still registered (204) or already removed (404).
`github-machine-worker.consumer.test.ts` drives `userGithub`, `githubOwner`,
`githubQueueJobSource`, `createOneJobRunner` and `removeOneJobRunner` through
every interaction with an injected Fetch, matching method, path, query,
headers and body exactly. No provider verification or live GitHub call is
claimed.
