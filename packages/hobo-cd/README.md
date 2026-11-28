# `@hobo/hobo-cd`

HoBo's CD as a HoBo project:

- **A Bindle** (`src/bindle.ts`): the CD service (`hobo serve cd`: the read
  API, the agent feed, health), its tick, the provider connections it reads,
  and its journal. The intended journal requirement (`cdJournal`) is a
  provider-neutral `postgres.database({ version: ">=16" })`; it is not yet
  attached to the Bindle. The declaration names no provider.
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
   connection up front, but when Vercel refuses the stored sign-in itself
   (HTTP 401 or 403 while naming its team), a `--hand-off` run connects Vercel
   again with the device grant in the same call; other runs refuse with
   `HOBO_CD_VERCEL_SIGN_IN_REJECTED`. `--what-if` opens nothing either.
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

### Where the journal and config are placed

Neither the journal nor the config is a provider this machine registers:
`hobo cd up`'s prepare step makes them. `src/placement.ts` declares the Yards
that say so, and `hobo cd plan|up` place on them alongside this machine's
providers:

| Resource | Yard | Provider | Product |
|---|---|---|---|
| `cd-journal` | `hobo-cd-journal` | `neon` | `neon.claimable-postgres/v1`, the fleet `prepare` provisions |
| `cd-config` | `hobo-cd-config` | `secrets` | `secrets.config-service/v1`, the owner's chosen store |

The config Yard names the routed config service, not a vendor: which store it
is (Infisical by default, 1Password or Bitwarden) is chosen when the run
starts. `hobo cd up` applies both by recording that `prepare` made them in the
same run; nothing is deployed for them, and `hobo cd down` never drops the
journal's databases or the owner's store.
The prepared-resource adapter accepts only the named journal and config on
their corresponding Yards. It refuses other resources assigned to those Yards
instead of recording them as provisioned.
CD up and down also refuse a runtime whose delivery or hosting supervisor owns
the executor, until that supervisor can guarantee the same retention. This
refusal occurs before the up ceremony provisions anything.

### The CD workload identity

HoBo.CD on Vercel (`packages/cd-vercel`) reads its journal from the owner's
store with its own Vercel OIDC token. `hobo cd up` makes what that needs, with
the owner's own sign-ins and the providers' APIs. Nobody creates it by hand
(`src/workload-identity.ts`):

1. It turns on team-mode OIDC tokens for the Vercel project `hobo-cd`, when
   the project exists. A new project gets them by default.
2. It creates an Infisical identity `hobo-cd` with Viewer access to the
   owner's project. Its OIDC Auth trusts that project's preview tokens:
   issuer `https://oidc.vercel.com/<team>`, subject
   `owner:<team>:project:hobo-cd:environment:preview`, and claim `owner_id`.
   The identity's id is kept in the store (`HOBO_CD_WORKLOAD_IDENTITY_ID`).
   A re-run reuses the identity and re-applies its trust. When two runs race,
   the identity saved first is kept and the other is deleted.
3. It gives the deployment the store's coordinates as its configuration:
   project, environment, folder and identity. These are ids only.

The step is skipped, with the reason, in three cases: on 1Password or
Bitwarden (only Infisical signs a workload in with OIDC), when the run holds
no Infisical sign-in, and when the Vercel connection names no team.

Configuration is a **ceremony**, not a list of environment variables, and it
survives the machine: the store is found through a locator of ids in
the owner's HoBo settings (`~/.config/hobo/projects/<project>/secret-store.json`,
never the repository) and signed in to on the page (the sign-in is held in
the run's trusted vault, in memory). A handed-off run on a remote box shows
no page: it takes an Infisical access token, a 1Password Connect token or a
Bitwarden personal API key from HoBo's own secret capture (a
`HOBO_OWNER_CAPTURE` line through the HoBo MCP server), never from the agent's
session or environment, and holds it in memory only. Whatever `hobo cd up` is missing is asked
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
| `cd-journal` | `standard`, 2 standbys | Desired policy for the rollout ledger: a five-minute recovery point and seven daily backups. This is a target, not a verified availability guarantee. |
| `cd-config`  | `rebuildable` | References into the secret store, which keeps its own replicas; `hobo cd up` rebuilds them idempotently. |

`hobo cd up` plans that fleet (`src/journal-fleet.ts`): a writer, the policy's
standbys and a witness, each a Neon Claimable Postgres database by default.
Creating a missing Neon member requires a durable, owner-scoped store with an
atomic create-if-absent operation; Neon cannot deduplicate a create across
processes or after a crash. The Infisical and Bitwarden vault adapters do not
advertise that operation, so they refuse creation of missing members. Existing
complete fleets can still be opened.
Each connection string goes straight into the
owner's secret store at `HOBO_CD_POSTGRES_URL_<ID>`, its claim link beside it at
`HOBO_CD_POSTGRES_CLAIM_<ID>` (claim each to keep it: an unclaimed database
expires), and the fleet's shape is kept in `HOBO_CD_SETTINGS`, so `hobo serve
cd` and `hobo deploy` open the same journal on any machine signed in to the
store. All default members are one
vendor in one region, which the fleet reports as a shortfall when it opens.

An experimental PostgreSQL fleet can be selected with `HOBO_CD_POSTGRES_FLEET`
(see `packages/cd/src/compose/README.md`). Member connection strings come from
secret-store entries (`HOBO_CD_POSTGRES_URL_<ID>`). Planned moves fence writes
at the database commit boundary. An unplanned failover cannot fence a
partitioned writer that the move never reached, and acknowledged writes there
can be absent from the new writer. Safe failover and its recovery point must
not be assumed. Snapshot copies and scheduled backups run while a host ticks
the fleet; independent failure domains are not proven. A reported policy
shortfall does not prevent the fleet from serving, and the absence of a
shortfall does not establish current replication or backup health.

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
Not yet run against live Vercel. `hobo cd plan` places CD on its own Yards,
whatever this machine has registered:

- `cd-api` and `cd-tick` go on CD's Vercel Yard (`packages/cd-vercel`).
- `cd-journal` and `cd-config` go on the Yards `hobo cd up` makes for them (see
  [Where the journal and config are placed](#where-the-journal-and-config-are-placed)).

`hobo cd up` then delivers `packages/cd-vercel` as one prebuilt build of the
current commit to CD's production on Vercel, and records the journal and config
as made by prepare. The deployment signs in with the CD workload identity
`hobo cd up` makes (see
[The CD workload identity](#the-cd-workload-identity)). Its store coordinates
reach it only inside that build: prepare hands them from the owner's store
session to the run (`CD_STORE_COORDINATES_HANDOFF`, in memory), and the build
bundles them as `deploy/secret-store.binding.json`, removed once the build is
staged. They are never Vercel variables and are never committed. Without the
owner's store session `hobo cd up` stops with
`HOBO_CD_UP_STORE_SESSION_REQUIRED`.
