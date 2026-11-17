# @hobo/cd-vercel

HoBo.CD on Vercel. Root directory of the Vercel project `hobo-cd`. Its Yard
is `deploy/yard.ts`; the Bindle it realizes is the CD project's
(`packages/hobo-cd/src/bindle.ts`). It is the CD counterpart of the relay's
`packages/ci-vercel`.

| Bindle resource | Here | Vercel |
|---|---|---|
| `cd-api` | `api/cd.ts` | A Function: `/healthz`, `/readyz` and the `/v1/cd/` mount (read API, agent delivery feed) |
| `cd-tick` | `api/tick.ts` | The `hobo-cd-tick` schedule, delivered to the `hobo-cd` queue topic: one bounded pass per delivery |
| `cd-journal` | (`@hobo/hobo-cd` `placement.ts`) | The Neon journal fleet `hobo cd up` provisions; not a Vercel resource |
| `cd-config` | (`@hobo/hobo-cd` `placement.ts`) | The owner's secret store; not a Vercel resource |

The tick is a schedule on a private queue trigger, not a cron path. Nothing
public needs a secret to call it.

## How it starts

Each instance composes CD once, on its first request or delivery
(`src/compose.ts`):

1. It reads the committed store binding (`deploy/secret-store.binding.json`,
   ids only) and opens the owner's store. It signs in with the deployment's
   own Vercel OIDC token (Infisical OIDC Auth), so no token is kept in Vercel's
   environment or in a file.
2. It reads the journal fleet `hobo cd up` keeps in that store: the roster in
   `HOBO_CD_SETTINGS`, and a connection string per member.
3. It opens the CD runtime on that fleet, then the CD host (`composeCdHost`
   from `@hobo/hobo/cd-platform`, the same host `hobo serve cd` runs).

A function has no disk worth a journal. A store with no fleet is therefore
refused (`cd-journal-not-provisioned`) rather than falling back to SQLite. A
composition that fails is forgotten, so the next request tries again.

`/healthz` answers 200 and names the build's commit whatever CD's state.
`/readyz` answers 200 once CD has composed. Until then it answers 503 with a
`code`:

- `cd-store-binding-missing`: no binding is committed yet.
- `cd-store-binding-invalid`: the committed binding is malformed.
- `cd-journal-not-provisioned`: the owner's store holds no journal fleet.
- `cd-store-unavailable`: the journal could not be opened.
- Otherwise, the CD runtime's own refusal code.

A deployment chooses which Camps CD manages with `HOBO_CD_TOPOLOGY`, a
comma-separated list of topology files relative to the function. They are
non-secret declarations.

## Status

The deployable and its tests (`test/`) exist. Two pieces are not done yet:

- `hobo cd up` does not deliver it yet; it will, by a git deployment of this
  directory, the way `hobo ci up` delivers the relay.
- No store binding is committed, because the CD workload identity (an
  Infisical identity that trusts this Vercel project's OIDC tokens) is not
  created yet.

Until both land, a deployment answers `/readyz` with
`cd-store-binding-missing`. The journal fleet's copy timer runs only while an
instance is alive. Driving it from the scheduled pass is not done yet.

## Architecture rules (AGENTS.md)

- **PACT at the boundary:** `contracts/cd-probes.pact.json` records what
  `hobo cd up`'s verification reads from `/healthz` and `/readyz`.
  `contracts/cd-probes.consumer.test.ts` holds the function's own entry to it.
- **Protobuf and CUE:** `data-models/cd_vercel.proto` defines the committed
  store binding and the probe bodies; `data-models/cd_vercel.cue` constrains
  them.
- **Parse, don't validate:** the committed binding is parsed once into a
  derived type, `CdStoreCoordinates` (a parsed Infisical binding plus an
  identity id that OIDC Auth's own parser accepted). A malformed binding is
  refused by name and never quoted. Nothing downstream re-checks it.
- **Event architecture:** this package holds no state of its own. Every
  command and event goes to the CD runtime's event store, the journal fleet
  (one writer, fenced commits). The conductor is the actor that claims each
  managed Camp under a lease. The read API answers from the CD runtime's
  projections (its materialized views, the read store), and the fleet's
  copies and backups are its snapshots. A function instance only composes
  these and forwards to them.
