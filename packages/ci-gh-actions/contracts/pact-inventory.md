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

Relay mode boundary: `relay-answer.pact.json` holds hand-authored consumer
expectations of the GitHub REST calls the relay-mode answerer makes when it
claims a check job (ADR-0183): `.hobo/ci.json` at the default branch, the job read (queued, 404 gone, and a 502 that is no
answer), one-job runner creation on the repository, the 403 that falls back to
the organization and the 409 that fences a job, runner deletion on either
scope, the queued and in-progress run lists and a run's jobs, and the runner
lists and run read of the sweep. `relay-answer-webhook.pact.json` holds the
`workflow_job` deliveries it receives: a signed queued check job (answered),
an unsigned one (401), another event and a job asking for more than the relay
label (both 202). Its signatures are HMAC-SHA256 with a fixture secret named in
the artifact, not a credential. `relay-answer.consumer.test.ts` drives
`createRelayAnswerer` through every interaction of both with a strict
transport and the in-memory runner service. No provider verification, runner
service traffic or live GitHub call is claimed.

Runner protocol boundary: `github-runner-service.pact.json` holds
hand-authored consumer expectations of the Actions runner protocol a one-job
runner speaks in relay mode (ADR-0183), read from the open-source runner
(`actions/runner`, MIT) at the commit its metadata names; each interaction
names the files under `src/` it came from. Its eight interactions are the
token exchange with an RS256 client assertion, opening a broker session, a
long poll that offers a job and one that returns nothing, the acknowledgement,
acquiring the job from the run service, completing it with a conclusion,
outputs and annotations, and deleting the session.
`../test/runner-protocol-pact.test.ts` drives `GithubRunnerServiceClient`
through every interaction in order and checks the client assertion's
signature with the JIT configuration's key. The relay-mode flag is off by
default; no runner service traffic, provider verification or live GitHub call
is claimed.

Read API boundary: `read-api.pact.json` holds hand-authored consumer
expectations of the relay's read API: the committed runner order, one
repository's route decisions a page at a time, the account's machines, stored
runs and a run attempt's jobs, signals, job times and usage, a token without
the read scope (403), another account's repository (404) and a host that keeps
no run history, which names the command that reads GitHub instead.
`read-api.consumer.test.ts` drives `ReadApiClient` through every interaction
and `read-api.provider.test.ts` answers every interaction from `createReadApi`
over a fixture store. The dashboard's own pact against the same provider lives
in `packages/ci-dashboard/contracts/`.

MCP insight boundary: `mcp-insights.pact.json` holds hand-authored consumer
expectations of the eight read-only insight tools: their list, the committed
runner order, a route explanation that records nothing, route decisions with
a cursor, machines, the nine signals, job times, a failed job's diagnosis and
usage, plus a credential without the read scope, another account's repository
and a stateless host with no route journal. `mcp-insights.provider.test.ts`
executes every interaction against the registered tools. No third-party MCP
client is claimed as verified.

Runner adoption boundary: `github-runner-labels.pact.json` holds hand-authored
consumer expectations, from GitHub's self-hosted runner and runner group REST
reference, of what runner adoption (`../src/runner-adoption.ts`) sends: the
signed-in user, the repository, its runners and runner groups, the organization's
runners, and adding or removing the adoption label on a repository or
organization runner. `github-runner-labels.consumer.test.ts` drives
`listAdoptableRunners`, `adoptRunner` and `releaseRunner` through every
interaction with an injected Fetch. No provider verification or live GitHub
call is claimed.

Actions minutes boundary: `github-billing-usage.pact.json` holds hand-authored
consumer expectations of the plan and billing usage reads behind the minutes
limit, for an organization and a user, a locked organization, the not-found
answers when the account kind is wrong, and a read refused for want of the
optional billing permission. `github-billing-usage.consumer.test.ts` drives
`GithubMinutesReader` through every interaction. A refused or failed read
leaves the limit unmeasured; it never blocks a step.

Runner-less checks boundary: `relay-checks.pact.json` holds hand-authored
consumer expectations of what the title and lint checks read of GitHub: the
pull request a run's ref names, `.hobo/ci.json` at its base branch, a
`pull_request_target` run from a fork and the open pull requests from its
head, and the commit archive, whose 302 to codeload is followed with no
Authorization header. `relay-checks.consumer.test.ts` drives the checks'
GitHub source through every interaction. No provider verification or live
GitHub call is claimed.

Provider usage boundaries: `depot-usage.pact.json`,
`namespace-usage.pact.json` and `warpbuild-usage.pact.json` hold hand-authored
consumer expectations of each vendor's documented usage API: one month's usage
and one refused credential each. `provider-usage.consumer.test.ts` drives
`DepotUsageReader`, `NamespaceUsageReader` and `WarpbuildUsageReader` against
a fake that answers only what the pacts declare
(`../test/support/provider-usage-pact.ts`). No vendor verification or paid API
call is claimed; a failing reader falls back to the ledger.
