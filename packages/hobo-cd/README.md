# `@hobo/hobo-cd`

HoBo's CD as a HoBo project:

- **A Bindle** (`src/bindle.ts`): the CD service (`hobo serve cd`: the read
  API, the agent feed, health), its tick, the provider connections it reads,
  and its journal. The journal's requirement (`cdJournal`) is a
  provider-neutral `postgres.database({ version: ">=16" })`, placed on a fleet
  of vendors by `placePostgresFleet`, so one vendor's outage is a failover.
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
   (Infisical OIDC by default, 1Password, or Bitwarden Secrets Manager),
   then installs HoBo CD's Vercel
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

`resolveVercelJunction(store, vault)` reads the junction's credential from the owner's
store for one convergence. The composed `hobo` converges `hobo cd up` with
the same journal, registry and actor host (one writer), and an executor whose
IaC provider is the Vercel deploy provider built from that credential. The
token is held in memory for the run and is never written to a file, an
environment file, a log or a result.

Configuration is a **ceremony**, not a list of environment variables, and it
survives the machine: the store is found through the committed locator
`.hobo/secret-store.json` and signed in to on the page (the sign-in is held in
the run's trusted vault, in memory); whatever `hobo cd up` is missing is asked
for and kept **in the secret store** as `HOBO_CD_SETTINGS` (the Integration's
slug and client id). The client secret is its own store entry, and the Vercel
token reaches the deploy through the vault, never an environment variable.
Setup clears the vault on refusal, error or a read-only plan; on success it
passes the vault to convergence, which clears it when the run ends. A late
setup callback cannot refill a cleared run's vault. JavaScript string copies
cannot be reliably erased.
`HOBO_CD_VERCEL_REDIRECT_URI` (non-secret) may still name the Redirect URL the
page listens on.

## Continuity: what CD keeps, and how hard

Each stateful resource declares its policy with the `continuity` trait
(`src/continuity.ts`, attached in `src/bindle.ts`), choosing the cheapest tier
that keeps what the data is for:

| resource     | tier          | why                                                                 |
| ------------ | ------------- | ------------------------------------------------------------------- |
| `cd-journal` | `standard`, 2 standbys | The rollout ledger. A few minutes' loss is re-derived from desired state, so a 5-minute recovery point is enough; three voting members fail over by majority when any one vendor stops; free tiers make the copies cheap; daily backups, 7 kept. |
| `cd-config`  | `rebuildable` | References into the secret store, which keeps its own replicas; `hobo cd up` rebuilds them idempotently. |

An experimental PostgreSQL fleet can be selected with `HOBO_CD_POSTGRES_FLEET`
(see `packages/cd/src/compose/README.md`). Member connection strings are read
from secret-store entries (`HOBO_CD_POSTGRES_URL_<ID>`). The fleet does not yet
fence an in-flight write at the database commit boundary and must not be relied
on for safe failover. A reported shortfall does not stop it serving.

## Continuity: what CD keeps, and how hard

Each stateful resource declares its policy with the `continuity` trait
(`src/continuity.ts`, attached in `src/bindle.ts`), choosing the cheapest tier
that keeps what the data is for:

| resource     | tier          | why                                                                 |
| ------------ | ------------- | ------------------------------------------------------------------- |
| `cd-journal` | `standard`, 2 standbys | Desired policy for the rollout ledger. Replication, independent failure domains, fenced failover, and scheduled backups are not yet proven. |
| `cd-config`  | `rebuildable` | References into the secret store, which keeps its own replicas; `hobo cd up` rebuilds them idempotently. |

An experimental PostgreSQL fleet can be selected with `HOBO_CD_POSTGRES_FLEET`
(see `packages/cd/src/compose/README.md`). It does not yet fence an in-flight
write at the database commit boundary and must not be relied on for safe
failover. A reported policy shortfall does not prevent the fleet from serving.

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
