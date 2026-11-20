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
even if another credential is available. Selecting the egress proxy sends its
placeholder rather than a token retained from another sign-in choice.
The intended relay connection reads credentials with its own workload identity
(OIDC); it still needs an end-to-end observation with the configured store.
For a remote owner hand-off, an existing 1Password service account can be
connected through the private owner form. Its credential stays in the scoped
owner session and is used by the in-process SDK; the remote path does not run
the 1Password CLI with owner information in its arguments. Provisioning and
every reuse authenticate the token and verify that its only accessible vault is
the configured vault. HoBo also bounds reuse to 24 hours after provisioning;
missing, expired, or later-dated reuse leases are refused before the SDK client
opens. Reuse validation and the in-process SDK's own traffic go through the
run's configured egress (proxy, bypass list, CA bundle), so a proxied runner
reaches 1Password; when it cannot, validation refuses rather than falling back
to an unvalidated token. A configured desktop account does not bypass these checks when a
service-account token is held; the Connect path uses its own bearer token.
Local owner-terminal setup continues to use the owner's CLI session.
Remote Bitwarden cloud sign-in keeps the personal API key in the session's
egress proxy: the run neither captures nor transmits its client secret. Private
owner-channel failures return an explicit refusal without exposing channel
errors.

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
