# `@hobo/hobo-cd`

HoBo's CD as a HoBo project:

- **A Bindle** (`src/bindle.ts`): the CD service (`hobo serve cd`: the read
  API, the agent feed, health), its tick, the provider connections it reads,
  and its journal. The Bindle currently declares generic resources: its
  exported `cdJournal` PostgreSQL requirement and `CD_TICK_SCHEDULE` cadence
  are not attached, and its API has no handler binding. `placePostgresFleet`
  ranks candidates; it does not provision or replicate a database. These
  connections must be implemented before this project can deploy CD.
  It names no provider.
- **A lifecycle**: `hobo cd up|down|plan|status` (and `hobo up` here) through
  the one HoBo engine. Re-running is idempotent, a changed declaration is an
  upsert, `--what-if` changes nothing, and `down` then `up` re-creates. This
  package is the CD project `hobo cd` uses by default (`cdProjectDir()`).
  Every other `hobo cd <x>` is `hobo deploy <x>`.
- **A CLI**: `hobo-cd up|down|plan|status`, i.e.
  `hobo cd <action> --project <this package>`.

## `hobo cd up` connects Vercel first, then deploys through the junction

`prepareVercelConnection` is the family's prepare step, mirroring CI's GitHub
connection:

1. **Idempotent.** If the installation id, token and explicit account scope are
   readable, it opens nothing. The stored `personal` marker (or an explicitly
   empty value) means a personal account; missing, unreadable or changed scope
   is refused until reconciled. Earlier personal installations omitted the
   marker: verify their scope before adding it. Later runs do not verify the
   connection online. `--what-if` opens nothing either.
   Headless runs refuse with the reason.
2. **Connect page** (`@hobo/connect-ui`). The owner chooses the store
   (Infisical OIDC by default, or 1Password), then installs HoBo CD's Vercel
   Integration. Vercel redirects to the Integration's registered Redirect URL,
   which the page serves on its fixed loopback port and path. The flow's
   `state` (compared in constant time) ties the answer to this connection.
3. **Exchange.** HoBo exchanges the one-time code at
   `POST /v2/oauth/access_token` with the integration's client secret, which is
   **read from the store** (`HOBO_CD_VERCEL_CLIENT_SECRET`, kept there once by
   the integration's owner), never from the environment. It verifies the token
   with `GET /v2/user`, then deposits the token, the team and the installation
   id into the store. The page sees references only.

### The Vercel provider junction

Yards hold only what is internal to their provider: the CD project runs in
`cdYard` (`provider: "local"`), and Vercel's projects and deployments are
internal to `vercelYard` (`provider: "vercel"`). Neither marks anything
external. `vercelJunction()` joins them (`@hobo/junctions`).

`resolveVercelJunction(store)` reads the junction's credential from the owner's
store for one convergence. The composed `hobo` converges `hobo cd up` with
the same journal, registry and actor host (one writer), and an executor whose
IaC provider is the Vercel deploy provider built from that credential. The
token is held in memory for the run and is never written to a file, an
environment file, a log or a result.

Configuration (environment, nothing secret): `HOBO_CD_VERCEL_INTEGRATION`,
`HOBO_CD_VERCEL_CLIENT_ID`, `HOBO_CD_VERCEL_REDIRECT_URI` (default
`http://127.0.0.1:8792/vercel/callback`), optional `HOBO_CD_SECRET_STORE`, and
the store's coordinates. The stores and the owner's sign-in are
`@hobo/hobo-ci`'s `openSecretStore`.

## Architecture rules (AGENTS.md)

- **PACT**: `contracts/pacts/vercel-integration.pact.json` (exchange,
  verification). The consumer test runs against a Vercel fake that answers
  from it.
- **Protobuf plus CUE**: `data-models/hobo_cd.proto` / `.cue`.
- **Parse, don't validate**: Vercel's token answer becomes the derived type
  `TokenSchema` (`icfg_` installation, `team_` team) before use. The user
  answer is parsed and must match.
- **Event architecture**: the connection is a command the lifecycle runs
  before `up`. The flow is the single actor deciding each transition, and the
  page shows a projection (materialized view) of the current step. This
  package keeps no event store, snapshot or read store of its own: the
  durable outcome is the store's write, and convergence is recorded on the
  deployment's event store by `hobo up`.

## Status

Tested end to end through the real connect page with a scripted browser and a
pact-driven Vercel fake; the in-memory `SecretsPort` stands in for the store.
Not yet run against live Vercel. `hobo cd plan` is honestly rejected until
providers for the journal, config and tick are registered: the Vercel deploy
provider realizes static/web deployments, not schedules or secrets.
