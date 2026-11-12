# HoBo CD from the `hobo` binary

`hobo deploy`, `hobo incident` and `hobo serve cd` all run against one
composition of `@hobo/cd` (`composeContinuousDelivery`, plan 0024 WP18). There
is no second delivery lane and no fixture path except `--simulate`, which is
labelled in every result (`data.simulated: true`, reason code `simulated` on
every observation).

## Composition

| Concern | Default | Configure |
|---|---|---|
| Journal | SQLite at `$HOBO_HOME/cd/journal.sqlite` | `HOBO_CD_SQLITE_PATH`; Postgres (>= 16) with `HOBO_CD_POSTGRES_URL` (`HOBO_CD_POSTGRES_POOL`). More than one replica (`HOBO_CD_REPLICAS`) requires Postgres. |
| Artifact store | filesystem at `$HOBO_HOME/cd/artifacts` | `HOBO_CD_ARTIFACT_ROOT`; s3-compatible with `HOBO_CD_S3_ENDPOINT` (https), `HOBO_CD_S3_BUCKET`, `HOBO_CD_S3_REGION`, `HOBO_CD_S3_CREDENTIAL_REF` |
| Tenant / Station | `local` / `local` | `HOBO_TENANT`, `HOBO_STATION` |
| Principal | the OS user | `HOBO_USER`; `HOBO_AGENT_ID` makes the session an agent principal (proposal-only unless granted, ADR-0094) |
| Telemetry | none | `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP JSON) |
| Topology | Yards and Camps (`@hobo/yards`, `@hobo/camps`); Camp ids are `<yard>/<camp>` | label `hobo.cd/management: observe-only` declares an OBSERVE_ONLY Camp |
| Rails | the journal's Station `rail.*` events | a Rail's `delivery` object (Camp sets, posture, failover, enrollment) |
| Kubernetes fleets | none | `HOBO_CD_KUBE_FLEET=<file.json>`: `{ "ocm": … }` or `{ "karmada": … }` realizer record, optional `clusterProfiles` import (OBSERVE_ONLY Camps) |
| Service tick | 1 s | `HOBO_CD_TICK_MS` |
| Credential locators | `env://NAME` resolved for one use, never stored | any `CredentialResolver` |

Ports the host did not configure fail closed: RUNBOOK and SUITE hooks refuse,
a Camp without Station cutover routing offers no traffic capability (a required
canary is refused as `progressive-unsupported`), and an unrouted NOTIFY is
dropped and counted. A reconciler mode with no realizer is refused with
`compose-realizer-missing`.

## `hobo deploy`

Run `hobo deploy` with no arguments for every usage line. Output is one
envelope for humans, scripts and agents: `--format json|text` (or `--json`)
changes only `message`; `data` holds the records as canonical protobuf JSON.
Every refusal has a `code` and at least one `remediation` (the next step).

| Group | Subcommands |
|---|---|
| Freight | `freight record --file <manifest.json>`, `freight list`, `freight show|yank|approve <id|alias>` |
| Sources | `source define --file`, `source list`, `source poll <name>` |
| Pipelines | `pipeline apply --file <pipeline.json|hobo.delivery.ts>`, `pipeline show <name>`, `pipeline list` |
| Windows | `window define --file`, `window list`, `window override <window> --camp <a,b> --reason` |
| Promotion | `promote <freight> --camp <a,b> [--pipeline --node] [--strategy] [--propose]`, `status`, `logs`, `rollback --camp --reason [--to <set>]`, `reconcile --camp`, `preview create|list`, `verify show <id>`, `metrics` |
| Agents | `agent token --camp-set`, `agent enroll --token --jwk-file`, `agent approve-key <id>`, `agent accept <id> --camp`, `agent run`, `agent revoke <id> --reason` |
| Publishers | `publisher define --file <TrustedPublisherRecord>` |
| Fleet | `campset define|list`, `camp list|show|taint|untaint|manage`, `placement define|decide|show`, `scores report`, `fanout show|halt|resume|rollback`, `failover list|approve`, `rebalance` |
| Policy | `compliance show <camp>`; Rails promote with `promote <rail-freight>` |
| Hosting | `hosting-status|hosting-resume|hosting-cancel|hosting-resume-mutation <deployment-id>` (unchanged) |

Promotions and rollbacks derive a deterministic idempotency key from their
inputs (override with `--idempotency-key`), so the same request twice is one
request (I12).

### Delivery as code

`hobo deploy pipeline apply --file hobo.delivery.ts` loads a module that
exports plain records (protobuf JSON form) and applies them in dependency
order: `publishers`, `sources`, `windows`, `campSets`, `placements`,
`pipelines`. An unknown export or a malformed record refuses the whole file
before anything is applied.

```ts
// hobo.delivery.ts
export const sources = [
  { name: "web-ci", bindle: "web", subscriptions: [{ name: "web-ci", kind: "SUBSCRIPTION_KIND_HOBO_CI", locator: "acme/web" }] },
];
export const pipelines = [
  {
    name: "web",
    bindle: "web",
    nodes: [
      { name: "staging", campIds: ["edge/staging"], sources: ["web-ci"], autoPromotion: "AUTO_PROMOTION_NEWEST" },
      { name: "prod", campIds: ["edge/prod"], sources: ["staging"], approvalRequired: true },
    ],
  },
];
```

### HoBo's own CI (dogfooding)

`@hobo/cd/compose` exports `hoboCiDogfoodSources({ ciPipeline })`: HOBO_CI
Freight sources for HoBo's CI relay (`hobo-ci-relay`) and runner fleet
(`hobo-ci-runner-fleet`). Write them into a delivery module and apply them;
their pipelines promote the relay and the fleet like any other Bindle.

## `hobo incident`

`incident status` lists failed, rolled-back and rejected promotions and open
failovers from the journal. `incident open --camp <camp> --signal <s>` runs the
CD rollback (D12): zero exposure, then a Delta to the predecessor Set through
the same gate. An agent principal's rollback is recorded as a proposal.

## `hobo serve cd`

`hobo serve cd [--port 8791] [--host 127.0.0.1] [--simulate]` hosts the CD
service: the tick loop, a conductor reconciler over the Station's MANAGED Camps,
`/v1/cd/` (read API for operators, delivery feed for enrolled agents),
`/healthz` and `/readyz`. Agents connect outbound to `/v1/cd/`; the Station
never dials an agent (I3).

## Runbook

- **`compose-realizer-missing`** on `serve cd` or `deploy reconcile`: no
  conductor realizer is composed for the Station. Configure one (Kubernetes
  fleets via `HOBO_CD_KUBE_FLEET`, the hosting-transition or orchestrator
  realizer through the host API), enroll agents for agent-mode Camps, or use
  `--simulate` for a labelled dry run. `/readyz` lists the refusal.
- **`compose-store-multinode`**: more than one replica on SQLite. Set
  `HOBO_CD_POSTGRES_URL`.
- **`cd-store-unavailable`**: the journal could not be opened. For SQLite check
  that `$HOBO_HOME` is writable; for Postgres check reachability and version.
- **`cd-kube-fleet-invalid`**: fix the `HOBO_CD_KUBE_FLEET` file (exactly one of
  `ocm`/`karmada`).
- **`delivery-module-invalid` / `delivery-module-unreadable`**: the
  `--file` module has an unknown export or a malformed record; nothing was
  applied. Fix the named record and re-run.
- **`agent-jwk-invalid`**: `agent enroll` takes the PUBLIC JWK; a key with a
  private member `d` is refused.
- **`cd-not-found`**: the named Freight, pipeline, Camp or decision does not
  exist; the remediation names the list command.
- Any other code comes from the owning `@hobo/cd` module; its remediation is in
  the envelope and in that module's README.
