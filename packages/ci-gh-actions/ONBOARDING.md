# Hosted GitHub App onboarding

The hosted relay can initialize its shared GitHub App without an existing App.
A platform operator provisions a PostgreSQL database, a 32-byte random encryption
key in the platform secret manager, an HTTPS relay origin, an operator bootstrap
bearer token and its SHA-256 digest, and an initial HoBo account identifier. The
operator bearer is distinct from every customer account bearer. Keep both raw
bearers and the encryption key out of source control and logs.

Open `/v1/app-bootstrap/setup` in a browser and enter the operator bearer and
App name. The page sends the bearer only in the `Authorization` header of a
same-origin POST to `/v1/app-bootstrap/start`; it never puts the bearer in a URL
or browser storage. API clients may instead POST JSON `{ "name": "HoBo CI" }`
with the operator bearer in `Authorization`. The
response sets an HttpOnly, Secure, SameSite=Lax browser cookie and returns an
`action` on `github.com` plus a `manifest` object. The setup page submits that
manifest as a form POST. API clients must make the same browser form POST to
the returned action, with a `manifest` field containing the JSON serialization
of that object. GitHub requires a signed-in App owner to approve creation. Its
callback returns to the same browser, exchanges the one-use code, and writes
App credentials encrypted in PostgreSQL. The manifest subscribes to
`workflow_job` and `workflow_run` and requests organization Members read access
for administrator verification. It registers the OAuth callback used below.

**Enable Device Flow for every HoBo CI App.** CLI and headless user authorization
must be supported, so this is part of the standard App setup rather
than an optional follow-up. After GitHub creates the App, open its settings and
select **Identifying and authorizing users → Enable Device Flow** before
completing setup. Do the same when connecting an existing App. Device flow
authorizes a user; the worker's private-key-based installation authentication is
a separate flow and does not require a user to sign in for each job.

GitHub's documented [manifest fields](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
and [registration URL parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters)
do not provide a device-flow switch. Do not add an unrecognized manifest field or
claim that registration enabled it automatically; complete the
[App settings step](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#enabling-or-disabling-the-device-flow).

An uncertain App conversion is fenced; subsequent bootstrap attempts are
refused until an operator reconciles the GitHub App and stored credentials. The
service must not create a replacement automatically: GitHub may have created the
original App despite a lost response.

For an existing App, open `/v1/app-registration/setup`, enter an account bearer
with `repositories:write`, and select **Connect GitHub**. The page keeps the
bearer in memory and sends it only in the `Authorization` header. API clients
can POST `/v1/app-registration/oauth/start` using the same account bearer. Navigate the same browser to the returned GitHub
`authorizeUrl`. The callback validates browser-bound, one-use state and PKCE,
checks the GitHub user, and sets a short-lived HttpOnly, Secure, SameSite=Lax
session cookie. The session and GitHub user token are encrypted server-side;
every operation rechecks the HoBo bearer and scope.

POST `/v1/app-registration/state` with `{ "purpose": "install" }` using that
browser session. The response contains a one-time state and `installationUrl`.
The URL is constructed from the canonical App ID and slug returned by GitHub's
App-authenticated `/app` endpoint. Navigate to it and install or update the App.
The callback verifies the session, consumes the one-time state, verifies App and
installation identity, and checks the authenticated GitHub user is the account
owner or an active organization administrator. Only then is the installation
bound uniquely to the HoBo account. The hosted account API includes that verified
installation in the caller's repository permissions.

For development, the focused OAuth tests use mocked GitHub requests. The
PostgreSQL integration contract uses a **fresh disposable database**:

```sh
HOBO_CI_TEST_POSTGRES='postgresql://…' pnpm exec tsx packages/ci-gh-actions/scripts/onboarding-postgres-contract.ts
```

The integration contract covers singleton bootstrap concurrency, App credential
encryption, state replay and browser binding, OAuth PKCE, account isolation and
control-token revocation. It does not contact GitHub or verify a deployed service.

## Public repositories and pull requests

After the App installation is bound to the account, the SDK can connect a
repository without creating a companion workflow. A verified owner using the
same browser and origin can create the SDK client with
`createCiRelayClient({ origin: window.location.origin, ownerSession: true })`;
the owner session delegates `getPolicy`, `getInstallations`, `putDesiredPolicy`,
`putProvider`, and `connectIsolatedRepository`, without exposing the account
token to the browser. Other SDK methods require their normal account credentials;
the hosted control plane disables the legacy `putPolicy` method.
To update an existing provider, copy its offer from `getPolicy()` and call
`putProvider(offer, { revision })` with that response's revision. The operation
can change the provider budget and concurrency and conservatively increase the
Sandbox bootstrap estimate. Provider budget cannot exceed the account budget.
The provider binding and usage observation remain unchanged; use the separate
observation workflow for updated provider pricing or a lower estimate.
Other clients supply an account token with the required scopes. Call
`client.connectIsolatedRepository({ repository: "owner/repo", installationId,
trustedRepositoryAcknowledged: true, publicRepositoryAcknowledged: true,
acceptAllMatchingRepositoryJobs: true },
{ revision })`, using the configuration revision from `client.getPolicy()`.
Both acknowledgments are required even for a private repository: GitHub can
assign any queued job matching the runner's labels while the runner is online,
including jobs from any event or branch, fork pull requests, and jobs requesting
default runner labels. Repository visibility can also change while it is online.
The grant covers every such job, and branch or event restrictions are not offered
for this shared-label mode. Routing and budget reservations cover the runner;
GitHub may assign it a different matching job from the one that triggered the
reservation. Revoking a connection or changing policy does not instantly stop
an already-live runner, which may accept a job while revocation is being applied.
When GitHub confirms that the job assigned to a runner has completed, HoBo stops
that runner and records its usage. Cancelling the original queued job does not
by itself prove that a shared-label runner is idle: it may accept a different
matching job and can remain online until its bounded Sandbox timeout. Each
worker wakeup checks GitHub for the status of assigned active Sandbox jobs;
operators should account for that per-runner API traffic as concurrency grows.
GitHub App identity, installation permissions, and
repository identity are verified before storing the connection.
The repository's workflow can then use `runs-on: hobo` when the hosted isolated
runner capability described below is available. The endpoint fails closed until
that capability is enabled and refuses to change the connection while its leases
are active.

Shared-label isolated onboarding requires an isolated host and explicit consent
to all matching repository jobs. The older bridge setup cannot authorize
isolated jobs under branch or event restrictions.

The Vercel composition enables the isolated host only when Sandbox is explicitly
configured. Without that configuration, isolated onboarding and dispatch fail
closed. Workflow-bridge admission, dispatch and JIT claims remain disabled.
Bridge setup requests fail before creating a plan or modifying the repository;
use isolated onboarding for this relay.
Configuration alone does not prove the live runner, provider identity or costs.

Account budgets and provider eligibility apply to each runner. Budget estimates
are not hard provider billing caps; the proxy gateway and provider metering can
incur costs outside the application quota. Host configuration alone is not proof
that the runner and egress path are ready. Live GitHub assignment, execution,
cleanup and settlement still need verification before relying on the service.
