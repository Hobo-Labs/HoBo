# `@hobo/hobo-ci`

HoBo's CI as a HoBo project. It is three things:

- **A Bindle** (`src/bindle.ts`): what CI deploys, the hosted CI relay (an
  HTTP entry, three private queues, a repair schedule, a cache it may lose, a
  read-only config service). The relay's declaration lives beside the code that
  serves it (`packages/ci-vercel/src/bindle.ts`) and this project deploys it
  unchanged. It names no provider.
- **A lifecycle**: `hobo ci up|down|plan` (and `hobo up` in this directory)
  converge it through the one HoBo engine, so re-running `up` is idempotent, a
  changed declaration is an upsert, `--what-if` changes nothing, and
  `hobo ci down` then `hobo ci up` re-creates it. This package is the CI
  project `hobo ci` uses by default (`ciProjectDir()`).
- **A CLI** (`hobo-ci up|down|plan|status`): the same lifecycle,
  `hobo ci <action> --project <this package>`, run by the `hobo` on PATH.

## `hobo ci up` connects GitHub first

Before the project converges, the family's prepare step
(`prepareGithubConnection`) makes sure a GitHub App exists and its
credentials are in the owner's secret store.

1. **Idempotent.** If all App credentials are readable, HoBo rechecks the
   signed App identity, owner, reviewed permissions and webhook against
   GitHub before reporting `unchanged`. An unreadable, partial or unverifiable
   connection is refused instead of being replaced. This check does not prove
   that the stored webhook or OAuth secrets work end to end. `--what-if`
   opens nothing either.
2. **A generative connect page** (`@hobo/connect-ui`, on vercel-labs/ui)
   opens in the browser. The owner chooses the store (Infisical Cloud with
   OIDC by default, 1Password, or Bitwarden Secrets Manager) and confirms
   GitHub's App screen,
   which receives HoBo's reviewed manifest.
3. GitHub sends the browser back with a one-time code. HoBo converts it,
   verifies the App with the reviewed `verifyConvertedGithubApp` (owner,
   origin, permissions, events, webhook URL, and the key itself), and writes
   the five credentials straight into the store. The page shows their
   references, never their values.
4. A refused or cancelled connection stops `up` before anything is deployed.
   Without a person at a browser (CI, no TTY), `up` refuses with the reason;
   later runs find the connection and skip the page.

**Connection credentials.** Setup filters known secret environment names and
secret-shaped values, but that heuristic cannot identify every possible secret.
The browser opener receives only an allowlist of desktop and process-location
variables; loader hooks and arbitrary application variables are excluded.
Other CI paths still read credentials from the environment. The store is found through
a locator in the owner's HoBo settings
(`~/.config/hobo/projects/<project>/secret-store.json`, never the repository:
which store, its ids, no credential). You sign in on the setup page: an Infisical access token from your
own `infisical login`, the 1Password desktop app (`OP_ACCOUNT`, unlocked with
your biometrics), or a Bitwarden Secrets Manager machine account token on the
US or EU cloud. The sign-in's vault buffer is cleared when setup ends, including
on refusal or error; a late callback cannot refill it. Copies of JavaScript
strings cannot be reliably erased. In CI, a preconfigured
Infisical machine identity with OIDC Auth (`INFISICAL_IDENTITY_ID` in the
locator) signs in with the job's own OIDC token. Bitwarden has no workload OIDC
sign-in, so a relay on Bitwarden reads back with its own machine account
token, kept by the platform; Infisical stays the default for that reason.
Selecting the Infisical OAuth application sign-in keeps the store read-only
even if another credential is available. A handed-off run on a remote box
shows no page: when the store's only missing piece is its sign-in token (an
Infisical access token or a 1Password Connect token), or Bitwarden needs your
personal API key, the run refuses with a `HOBO_OWNER_CAPTURE` line and takes
the value from HoBo's own secret capture (the HoBo MCP App's form), holding it
in memory only. Nothing is stored in the agent's session or environment.
When HoBo provisions its own Infisical access, it checks the project the
locator names and uses it only if it is a Secrets Management project. Otherwise
it uses the organization's only Secrets Management project, or the one named
`hobo`, or creates `hobo`; several projects with none named `hobo` refuse with
`HOBO_<FAMILY>_INFISICAL_PROJECT_AMBIGUOUS`, naming them. The environment is
`INFISICAL_ENVIRONMENT` (default `prod`) when the project has it, else the
first of `production`, `prod`, `staging` and `dev`, else a `prod` environment
HoBo creates. The resolved project and environment are written back to the
locator; refusals carry names, never project or identity ids.
The intended relay connection reads credentials with its own workload identity
(OIDC); it still needs an end-to-end observation with the configured store.
When updating an existing 1Password item, HoBo preserves its other metadata and
refuses the update if the item changed since it was read. Displayed 1Password
references point to the item's `password` field.

Configuration is a **ceremony**, not a list of environment variables, and it
survives the machine: whatever `hobo ci up` is missing is asked for on the
setup page, checked, and kept **in the secret store** as `HOBO_CI_SETTINGS`
(the relay URL and the App's owner), beside the App's credentials. A destroyed
devbox is set up again by cloning (the locator comes with the repository) and
signing in; nothing else is asked.

**Users or organizations own the App.** The reviewed conversion verifies
the owner's ID and type. `HOBO_CI_APP_HOST` pins the host; an unknown or
unimplemented host is refused before opening the store. If a host cannot
serve the owner's kind, setup names a compatible host instead of creating an
App that would be refused. An invalid organization login supplied in the
environment is refused before the store or App page is opened.

## Where `hobo ci up` places the relay

`hobo ci plan` and `hobo ci up --what-if` plan against the relay's own Yards
(`packages/ci-vercel/deploy/yard.ts`): the Vercel project `hobo-ci` (Functions,
Queues, Cron Jobs, the Marketplace cache) and the Yards its junction joins (the
config service's secret projection, the non-Vercel caches). Every relay resource
places there, whatever providers this machine has registered. `hobo ci up`
delivers the current branch to the project's preview, as `hobo ci deploy` does,
with the Vercel connection `hobo cd up` keeps in your secret store; the prepare
step hands only that connection on, in a trusted vault, and ends the store
sign-in. Production is `hobo ci deploy --target production --sha <commit>`.

## Continuity

The relay this project deploys declares a `continuity` policy on every
stateful resource (`RELAY_CONTINUITY`, `packages/ci-vercel`). Everything it
keeps is rebuilt from GitHub, so every policy is `rebuildable` and nothing is
copied. HoBo CD, which does keep a ledger, runs it on a PostgreSQL fleet
(`packages/hobo-cd` README, "Continuity").

## Private owner HTTP

`isolatedOwnerFetch(env, options)` sends each request in a child process. It
buffers the response before resolving and defaults to a 1 MiB response limit;
`maxResponseBytes` accepts an integer from zero through 32 MiB. Request bodies,
including streams, are fully buffered before the child starts; bodies over
32 MiB are refused. URL, header, certificate and encoded-packet limits can also
refuse a request before the child starts.
It isolates request diagnostics from the parent process; it is not connected to
a verified production owner session. Requests require HTTPS, and automatic
redirects stay within the original origin so credential headers do not cross
origins. A caller can inspect a redirect with `redirect: "manual"`. For local
synthetic tests only, `allowInsecureLoopback` permits HTTP to the literal
loopback address `127.0.0.1` or `::1` without a proxy, with redirects limited
to that same origin. An HTTPS request cannot be downgraded to HTTP.
Configured proxies with URL credentials must use HTTPS, even when a bypass
list is present; unauthenticated HTTP CONNECT proxies remain supported. Each
private request permits at most 32 proxy connection attempts; exhaustion after
dispatch has an uncertain outcome.
The `env` argument is read when the transport is constructed. A proxy value that
is not a valid HTTP(S) URL throws `HOBO_SETTING_INVALID` synchronously during
construction. Proxy selection uses the first nonempty `HTTPS_PROXY`,
`https_proxy`, `ALL_PROXY`, or `all_proxy`;
the bypass list uses `NO_PROXY` then `no_proxy`. The extra CA bundle uses
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, then `REQUESTS_CA_BUNDLE`.
Oversized responses and cancellation after dispatch fail with an uncertain
outcome. `PrivateOwnerRequestError` indicates the request could not be prepared;
cancellation before dispatch raises `AbortError`. `PrivateOwnerDispatchError`
means the operation may have reached its target. Confirm a terminal outcome
using operation-specific evidence or reconcile it before retrying; if the
outcome remains unknown, do not retry. Pass an `AbortSignal` to cancel a slow
response. The child uses the parent's effective trust roots and the selected
extra CA bundle without inheriting Node preload options. Encoded trust snapshots
are limited to 8 MiB; larger snapshots are refused before the child starts.
Request-body preparation and the dispatched request each have a 120-second
ceiling.
Private owner HTTP requires a runtime that exposes `tls.getCACertificates`:
Node 22.15 or later within Node 22, Node 23.10 or later within Node 23, or Node
24. Other versions are refused before dispatch until their trust behavior is
verified. Requests are also refused if Node's reported default roots omit
occurrences of its bundled or startup-extra roots, because that report may not
match the active TLS configuration.

## Architecture rules (AGENTS.md)

- **PACT**: `contracts/pacts/github-app-manifest.pact.json` (conversion, App
  identity, webhook config), run by the consumer test against a GitHub fake that
  answers from the pact.
- **Protobuf plus CUE**: `data-models/hobo_ci.proto` / `.cue` (connection
  config, the prepare step's report, credential references).
- **Parse, don't validate**: GitHub's conversion answer becomes the derived
  type `ConversionSchema` before any value is used, and the converted App is
  checked again by the verifier against GitHub's live answer. The callback's
  `state` is compared in constant time.
- **Event architecture**: the connection is a command the lifecycle runs
  before `up`. The connect flow is the single actor deciding each transition,
  and the page shows a projection (a materialized view of the current step)
  rebuilt per request. This package keeps no event store, snapshot or read
  store of its own: the durable outcome is the secret store's write, and the
  convergence that follows is recorded on the deployment's own event store by
  `hobo up`.

## Status

Driven end to end in tests through the real connect page server with a scripted
browser and a pact-driven GitHub fake; the in-memory `SecretsPort` stands in
for Infisical. Not yet run against live GitHub or a live store from this
repository. `hobo ci up` plans the relay but the plan is rejected until a
provider for its queues, cache and config service is registered (the CD
project's Vercel junction).
