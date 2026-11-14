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
2. **A generative connect page** (`@hobo/connect-ui`, json-render on
   shadcn/ui) opens in the browser. The owner chooses the store (Infisical
   Cloud with OIDC by default, or 1Password) and confirms GitHub's App screen,
   which receives HoBo's reviewed manifest.
3. GitHub sends the browser back with a one-time code. HoBo converts it,
   verifies the App with the reviewed `verifyConvertedGithubApp` (owner,
   origin, permissions, events, webhook URL, and the key itself), and writes
   the five credentials straight into the store. The page shows their
   references, never their values.
4. A refused or cancelled connection stops `up` before anything is deployed.
   Without a person at a browser (CI, no TTY), `up` refuses with the reason;
   later runs find the connection and skip the page.

**Secretless and passwordless for the owner.** Infisical uses your own session
(`INFISICAL_TOKEN` from `infisical login`). 1Password uses the desktop app's
integration (`OP_ACCOUNT`, unlocked with your biometrics), or a service
account token where no desktop app runs. HoBo writes none of these anywhere.
The relay reads the credentials back with its own workload identity (OIDC),
so no secret is put in the repository, a CI variable or the page.
When updating an existing 1Password item, HoBo preserves its other metadata and
refuses the update if the item changed since it was read. Displayed 1Password
references point to the item's `password` field.

Configuration (environment, nothing secret): `HOBO_CI_PUBLIC_URL`,
`HOBO_CI_GITHUB_OWNER`, `HOBO_CI_GITHUB_OWNER_ID`, `HOBO_CI_GITHUB_OWNER_TYPE`
(`User` by default, or `Organization`), optional `HOBO_CI_SECRET_STORE`
(`infisical` | `1password`), and the store's coordinates (`INFISICAL_PROJECT_ID` /
`INFISICAL_ENVIRONMENT` / `INFISICAL_SECRET_PATH`, or `OP_VAULT_ID`).

**Users or organizations own the App.** The App is created under the owner's
settings (an organization's when it is one) and verified as that owner's
(`verifyConvertedGithubApp` with `expectedOwnerId` and `expectedOwnerType`).
How the App is hosted is resolved for the owner (`resolveGithubAppHost`):
`HOBO_CI_APP_HOST` pins a host. If a pinned host cannot serve the owner's kind,
`hobo ci up` says so and names the hosts that can, rather than creating an App
that would then be refused. Unpinned, resolution takes the first host that
satisfies every criterion. The implemented `manifest` host supports both
owner kinds. An unknown host or the not-yet-wired `hosted-relay` option is
refused rather than silently starting the local manifest flow.

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
