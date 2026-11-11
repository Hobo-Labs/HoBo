# GitHub Actions boundary inventory

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
