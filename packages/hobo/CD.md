# HoBo CD from the `hobo` binary

`hobo deploy`, `hobo incident status` and `hobo serve cd --port 8791` all run
against one composition of `@hobo/cd` (`composeContinuousDelivery`). There is no second delivery lane and no fixture path except
`--simulate`, which is labelled in every result (`data.simulated: true`, reason
code `simulated` on every observation). None of them needs a Bindle in the
working directory: they act on the Station's journal and its declared topology.

## Composition

| Concern | Default | Configure |
|---|---|---|
| Journal | SQLite at `$HOBO_HOME/cd/journal.sqlite` | `HOBO_CD_SQLITE_PATH`; Postgres (>= 16) with `HOBO_CD_POSTGRES_URL` (`HOBO_CD_POSTGRES_POOL`). More than one replica (`HOBO_CD_REPLICAS`) requires Postgres. |
| Artifact store | filesystem at `$HOBO_HOME/cd/artifacts` | `HOBO_CD_ARTIFACT_ROOT`; s3-compatible with `HOBO_CD_S3_ENDPOINT` (https), `HOBO_CD_S3_BUCKET`, `HOBO_CD_S3_REGION`, `HOBO_CD_S3_CREDENTIAL_REF` |
| Tenant / Station | `local` / `local` | `HOBO_TENANT`, `HOBO_STATION` |
| Principal | the OS user | `HOBO_USER`; `HOBO_AGENT_ID` makes the session an agent principal (proposal-only unless granted, ADR-0094) |
| Telemetry | none: nothing is exported | `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP JSON) |
| Topology | none | `--yard <file,...>` on every `deploy`/`incident`/`serve cd` command, and `HOBO_CD_TOPOLOGY=<file,...>` (see [Topology from the repository](#topology-from-the-repository)). Camp ids are `<yard>/<camp>`; label `hobo.cd/management: observe-only` declares an OBSERVE_ONLY Camp |
| Rails | the journal's Station `rail.*` events | a Rail's `delivery` object (Camp sets, posture, failover, enrollment); a topology file's `rails` export is the Station's Rail while its journal has none active, and the only source of `approvedProviders` placement reads (without it placement refuses `rail-providers-unknown`) |
| Runner hosts | none | `HOBO_CD_RUNNER_HOST=<agent config.json>` on a runner host: `agent run` registers the runner-host realizer (packages/ci-gh-actions/deploy/runner-fleet/README.md) |
| Kubernetes fleets | none | `HOBO_CD_KUBE_FLEET=<file.json>`: `{ "ocm": … }` or `{ "karmada": … }` realizer record, optional `clusterProfiles` import (OBSERVE_ONLY Camps) |
| Service tick | 1 s | `HOBO_CD_TICK_MS` |
| Credential locators | `env://NAME` resolved for one use, never stored | any `CredentialResolver` |

Ports the host did not configure fail closed: RUNBOOK and SUITE hooks refuse,
a Camp without Station cutover routing offers no traffic capability (a required
canary is refused as `progressive-unsupported`), and an unrouted NOTIFY is
dropped and counted. A reconciler mode with no realizer is refused with
`compose-realizer-missing`.

## Topology from the repository

Camps are declared where the repository declares them, and a CD command reads
them from the files it is given (`--yard`, `HOBO_CD_TOPOLOGY`; both take a
comma-separated list, the environment's first):

- a **Yard module**: `export default yard(...)` from `@hobo/yards`, such as the
  CI relay's [`packages/ci-vercel/deploy/yard.ts`](../ci-vercel/deploy/yard.ts)
  (Camps `hobo-ci-relay/hobo-ci-relay/preview` and
  `hobo-ci-relay/hobo-ci-relay/production`);
- a **delivery module** that also exports `yards` (Yards) and/or `camps`
  (Camp records: `campId` `<yard>/<camp>`, `yardId`, `provider`, `envType`,
  optional `regions`, `labels`, `stationId`, `management`), such as the runner
  fleet's
  [`packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts`](../ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts)
  (one Camp per runner host, `hobo-ci-runners/<host>`), or the **release
  topology**
  [`release/hobo-release.delivery.ts`](../../release/hobo-release.delivery.ts)
  (Camps `hobo-release/<npm|oci|pages>-<candidate|stable>`, see
  [release channels](../../docs/design/release-channels.md#hobo-releases-through-hobo-cd)).
- a module or JSON file that exports `rails`: Station Rail declarations
  (`id`, `name`, `version`, `stationId` (empty: this Station),
  `approvedProviders`, `delivery`, `metadata`), each built with
  `@hobo/stations` `createRail` so its digest is computed, never read. The
  runner fleet's module declares one that binds its Camp set and approves
  `self-hosted`. A Rail the Station's journal activated wins over a declared
  one; two declared Rails for one Station refuse `cd-rail-conflict`.


### Publication Camps (catalog resolver realizers)

A Camp whose `provider` is `@hobo/provider-npm`, `@hobo/provider-oci-registry`
or `@hobo/provider-github` (or its native id) is realized by that provider's
shipped resolver (`createCatalogResolverRealizer` in `cd-runtime.ts`), and the
planner offers it exactly that product as a port, so a declaration resource
`{ "type": "data.v1", "port": "hobo:<product id>" }` places only there. The
Camp's labels bind where (`CATALOG_REALIZER_LABELS` in
`provider-hosting-catalog.ts`); the Freight binds what, by digest:

| Provider | Camp labels | Freight |
|---|---|---|
| all | `hobo.cd/credential-ref`: the one locator the resolver may use (`env://NAME`); nothing else is resolved for the Camp. Optional `hobo.cd/realize-mode`: `converge` (default) or `observe` (resolver `read` only, never a write) | |
| npm | `hobo.cd/npm.registry` (`npmjs`, `github-packages`, `https://` origin), `hobo.cd/npm.auth` (`token`, `oidc-trusted-publishing`, or `anonymous` for an observe-only Camp that resolves no credential), `hobo.cd/npm.provenance: required`, optional `hobo.cd/npm.dist-tag` | `PACKAGE` artifacts named `<package>@<version>`, optional `<name>.sigstore` bundle, label `hobo.cd/npm.dist-tag` |
| oci-registry | `hobo.cd/oci.registry` (host), `hobo.cd/oci.auth-realm`, `hobo.cd/oci.username` (non-secret), optional `hobo.cd/oci.tags` | `OCI_IMAGE` artifacts with a `<host>/<repo>@<digest>` coordinate on that host (already there, or every blob in the artifact store: the realizer pushes them on a byte transport), label `hobo.cd/oci.tags`, optional `hobo.cd/oci.mount-from` (a repository on that host to cross-mount blobs from) |
| github | `hobo.cd/github.repository` (`owner/repo`), `hobo.cd/github.pages.branch`, `hobo.cd/github.pages.path` | a `STATIC_ASSETS` `hobo.static-site-tree/v1` index (its file blobs in the store), label `hobo.cd/github.commit-message` |

CONVERGED is reported only when every resolver outcome reads `ready` from its
own observation; a resolver refusal is a BLOCKED observation carrying its
typed code. A missing or invalid label, or a Freight artifact the Camp cannot
bind, is `catalog-binding-invalid`; the npm provider limits are named
`npm-provenance-bundle-missing` and `npm-oidc-scoped-unsupported`. These Camps
are the conductor realizer unless `--simulate` or the host supplies another; a
topology that also opens a Kubernetes fleet (`HOBO_CD_KUBE_FLEET`) is refused
with `cd-conductor-conflict` instead of silently using one conductor. Planning reads a Freight's
declaration by `canonicalManifestHash`, the digest the build records (`hobo` build verb, D13).

`pipeline apply --file <module>` also reads the module it applies as topology.
Every export is parsed once with the generated `cd_topology.proto` schemas
(`data-models/`); a malformed record, a Yard that is not a `@hobo/yards` Yard,
a Camp declared for another Station or the same Camp declared twice refuses
the whole command before the journal opens. Other exports of a Yard module are
not topology and are ignored here.

## `hobo deploy`

Run `hobo deploy` with no arguments for every usage line. Output is one
envelope for humans, scripts and agents: `--format json|text` (or `--json`)
changes only `message`; `data` holds the records as canonical protobuf JSON.
Every refusal has a `code` and at least one `remediation` (the next step).

Each subcommand takes exactly the flags its usage line names, plus `--format`,
`--simulate` and `--yard`, typed by the shell (`@hobo/cli`
`src/shell/subcommands.ts`): a value flag takes the next token or
`--name=value`, a switch takes none. Any other flag is refused with
`Unknown option` (`HOBO_CLI_USAGE`), as for every other verb.

| Group | Subcommands |
|---|---|
| Freight | `freight record`, `freight list`, `freight show`, `freight yank`, `freight approve` |
| Sources | `source define`, `source list`, `source poll` |
| Pipelines | `pipeline apply`, `pipeline show`, `pipeline list` |
| Windows | `window define`, `window list`, `window override` |
| Promotion | `promote`, `status`, `logs`, `rollback`, `reconcile`, `preview create`, `preview list`, `verify show`, `metrics` |
| Agents | `agent token`, `agent enroll`, `agent approve-key`, `agent accept`, `agent run`, `agent revoke` |
| Publishers | `publisher define` |
| Fleet | `campset define`, `campset list`, `camp list`, `camp show`, `camp taint`, `camp untaint`, `camp manage`, `placement define`, `placement decide`, `placement show`, `scores report`, `fanout show`, `fanout halt`, `fanout resume`, `fanout rollback`, `failover list`, `failover approve`, `rebalance` |
| Policy | `compliance show`; Rails promote with `promote` and Rail Freight |
| Hosting | `hosting-status`, `hosting-resume`, `hosting-cancel`, `hosting-resume-mutation` (unchanged) |

Promotions and rollbacks derive a deterministic idempotency key from their
inputs (override with `--idempotency-key`), so the same request twice is one
request (I12).

### Examples

Run from the repository root. Every line below is executed by
`test/cd-md-examples.test.ts` against the built binary (with `--simulate` and a
temporary `HOBO_HOME`); none may fail in the shell. Names such as
`hobo-ci-relay@1` or `freight-manifest.json` stand for your own Freight and
files.

```sh
hobo deploy
hobo deploy freight record --file freight-manifest.json
hobo deploy freight list --bindle hobo-ci-relay --limit 20
hobo deploy freight show hobo-ci-relay@1
hobo deploy freight yank hobo-ci-relay@1 --reason cve-2026-0001
hobo deploy freight approve hobo-ci-relay@1 --camp hobo-ci-relay/hobo-ci-relay/production --reason hotfix --ttl-ms 3600000
hobo deploy source define --file packages/ci-vercel/deploy/delivery.ts
hobo deploy source list
hobo deploy source poll hobo-ci-relay
hobo deploy pipeline apply --file packages/ci-vercel/deploy/delivery.ts --yard packages/ci-vercel/deploy/yard.ts
hobo deploy pipeline apply --file packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy pipeline show hobo-ci-relay
hobo deploy pipeline list
hobo deploy window define --file change-window.json
hobo deploy window list
hobo deploy window override weekend-freeze --camp hobo-ci-relay/hobo-ci-relay/production --reason incident-fix --ttl-ms 3600000
hobo deploy promote hobo-ci-relay@1 --camp hobo-ci-relay/hobo-ci-relay/preview --pipeline hobo-ci-relay --node preview --strategy all-at-once --yard packages/ci-vercel/deploy/yard.ts
hobo deploy promote hobo-ci-relay@1 --camp hobo-ci-relay/hobo-ci-relay/production --source-camp hobo-ci-relay/hobo-ci-relay/preview --propose --idempotency-key relay-production-1 --yard packages/ci-vercel/deploy/yard.ts
hobo deploy status --camp hobo-ci-relay/hobo-ci-relay/preview --limit 10 --yard packages/ci-vercel/deploy/yard.ts
hobo deploy logs --camp hobo-ci-relay/hobo-ci-relay/preview --limit 50
hobo deploy rollback --camp hobo-ci-relay/hobo-ci-relay/production --reason slo-burn --to set-1 --idempotency-key rollback-1 --yard packages/ci-vercel/deploy/yard.ts
hobo deploy reconcile --camp hobo-ci-relay/hobo-ci-relay/preview --yard packages/ci-vercel/deploy/yard.ts
hobo deploy preview create hobo-ci-relay@1 --source-camp hobo-ci-relay/hobo-ci-relay/preview --ttl-ms 86400000 --pipeline hobo-ci-relay --node preview --idempotency-key preview-42
hobo deploy preview list
hobo deploy verify show verification-1
hobo deploy metrics --window-ms 604800000 --camp hobo-ci-relay/hobo-ci-relay/production
hobo deploy agent token --camp-set hobo-ci-runner-fleet --camp hobo-ci-runners/box --mode agent --ttl-ms 3600000 --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy agent enroll --token bootstrap-token --jwk-file public.jwk.json
hobo deploy agent approve-key reconciler-1
hobo deploy agent accept reconciler-1 --camp hobo-ci-runners/box --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy agent run --feed https://station.example/v1/cd/ --reconciler reconciler-1 --key-file agent.jwk.json --svid-file agent.svid --camp hobo-ci-runners/box
hobo deploy agent revoke reconciler-1 --reason host-retired
hobo deploy publisher define --file trusted-publisher.json
hobo deploy campset define --file packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy campset list
hobo deploy camp list --campset hobo-ci-runner-fleet --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy camp list --yard packages/ci-vercel/deploy/yard.ts
hobo deploy camp show hobo-ci-runners/box --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy camp taint hobo-ci-runners/box --key maintenance --value disk-swap --effect no-place --reason disk-swap --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy camp untaint hobo-ci-runners/box --key maintenance --effect no-place --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy camp manage hobo-ci-runners/box --management observe-only --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy placement define --file packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy placement decide hobo-ci-runner-fleet --pipeline hobo-ci-runner-fleet --node fleet --station local --count 1 --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
hobo deploy placement show hobo-ci-runner-fleet
hobo deploy scores report --file score-snapshot.json
hobo deploy fanout show --pipeline hobo-ci-runner-fleet --node fleet
hobo deploy fanout halt fanout-1 --reason pilot-failed
hobo deploy fanout resume fanout-1
hobo deploy fanout rollback fanout-1 --reason pilot-failed
hobo deploy failover list --camp hobo-ci-relay/hobo-ci-relay/production --limit 10
hobo deploy failover approve failover-1
hobo deploy rebalance --pipeline hobo-ci-runner-fleet --node fleet --reason drain-box --idempotency-key rebalance-1
hobo deploy compliance show hobo-ci-relay/hobo-ci-relay/production --yard packages/ci-vercel/deploy/yard.ts
hobo deploy hosting-status deployment-1
hobo deploy hosting-resume deployment-1
hobo deploy hosting-cancel deployment-1
hobo deploy hosting-resume-mutation deployment-1
hobo incident status --camp hobo-ci-relay/hobo-ci-relay/production
hobo incident open --camp hobo-ci-relay/hobo-ci-relay/production --signal slo-burn --reason error-budget --yard packages/ci-vercel/deploy/yard.ts
hobo serve cd --port 8791 --host 127.0.0.1 --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
```

### Delivery as code

`pipeline apply --file hobo.delivery.ts` loads a module that exports plain
records (protobuf JSON form) and applies them in dependency order:
`publishers`, `sources`, `windows`, `campSets`, `placements`, `pipelines`. It
may also export topology (`yards`, `camps`; see above), which is read, not
applied. An unknown export or a malformed record refuses the whole file before
anything is applied.

```ts
// hobo.delivery.ts
export const camps = [
  { campId: "edge/staging", yardId: "edge", provider: "vercel", envType: "staging" },
  { campId: "edge/prod", yardId: "edge", provider: "vercel", envType: "production" },
];
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
their pipelines promote the relay and the fleet like any other Bindle. The
relay's Camps come from its Yard module and the fleet's from its delivery
module (the examples above).

## `hobo incident`

`incident status` lists failed, rolled-back and rejected promotions and open
failovers from the journal. `incident open` (with `--camp` and `--signal`)
runs the CD rollback (D12): zero exposure, then a Delta to the predecessor Set
through the same gate. An agent principal's rollback is recorded as a proposal.

## `hobo serve cd`

`serve cd` (with `--port`, default 8791, `--host`, default 127.0.0.1,
`--simulate` and `--yard`) hosts the CD service: the tick loop, a conductor
reconciler over the Station's MANAGED Camps, `/v1/cd/` (read API for
operators, delivery feed for enrolled agents), `/healthz` and `/readyz`.
Agents connect outbound to `/v1/cd/`; the Station never dials an agent (I3).

## Runbook

- **`Unknown option` (`HOBO_CLI_USAGE`)**: the flag is not one the subcommand
  declares. Run `hobo deploy` for every usage line.
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
- **`pipeline-unknown-camp`, `token-scope-invalid`, an empty `camp list`**: the
  Camps are not in the topology this command read. Pass the Yard or delivery
  module that declares them with `--yard` (or set `HOBO_CD_TOPOLOGY`).
- **`cd-topology-invalid` / `cd-topology-unreadable`**: a `--yard` or
  `HOBO_CD_TOPOLOGY` file has a malformed `yards`/`camps` record or does not
  load; nothing was opened. Fix the named record.
- **`rail-providers-unknown`** on `placement decide`: the Station's active Rail
  has no approved providers this host can read. Declare the Rail beside the
  Camps (`rails` export) or pass the module that does with `--yard`.
- **`runner-host-interface-missing`** on `agent run`: `HOBO_CD_RUNNER_HOST` is
  set, so the runner-host realizer is registered, but this process has no
  source for the controller port (the container engine, or the supervised
  process's control files) or for one of the worker's job ports (leases,
  runner presence, mesh advert, admission gate); the message names each
  `<port>.<method>`. Run it from a composition that supplies them (the
  worker's data directory, `controller: {mode: "process"}` under the
  controller supervisor), or upgrade the host by hand.
- **`runner-host-config-invalid` / `runner-host-camp-unbound`**: fix the agent
  config the variable names, or start the agent with `--camp
  hobo-ci-runners/<its host id>` only. On the Station, `runner-host-camp-unbound`
  also refuses a promotion whose Set plans a runner-host row for a Camp
  outside `hobo-ci-runners/`.
- **`runner-host-image-unresolved` / `runner-host-release-unresolved`**: the
  Set has no runner-host row with the digest-pinned parameter this host
  runs. On the Station, promotion refuses `runner-host-image-unresolved` for
  Freight without a digest-pinned `hobo-ci-worker` image; promote the
  Freight the fleet's source (`hobo-ci-runner-image`) discovered. A process
  host refuses `runner-host-release-unresolved` when that Freight carries no
  controller release: apply the delivery module with
  `HOBO_CI_RUNNER_RELEASE_INDEX` set so each Freight pairs the image with its
  releases. Until a release index is published, a process host is adopted
  by hand once (`HOBO_CI_CONTROLLER_RELEASE` under the controller supervisor,
  packages/ci-gh-actions/README.md); there is no `--adopt` for a runner
  host's first Set (unlike the relay's `--adopt`, packages/ci-vercel/README.md), so a
  fresh host stays unplaced until its agent reports against one.
- **`planning-declaration-missing`** on a runner fleet promotion: the Freight
  was ingested by hand, or the fleet's source was redefined after it
  discovered the Freight; the Station plans only Freight whose declaration
  digest is the applied source's. Promote Freight the current source
  discovered.
- **`runner-host-not-converged` / `runner-host-unready`** in a runner fleet
  promotion's verification: the host's agent reported the Set refused (for
  example `runner-host-verify-failed`, restored to the previous digest) or
  the host is not ready. A BLOCKED report fails the host at once
  (`rollout-camp-blocked`, carrying the agent's reasons) instead of waiting
  out the progress deadline; the host's Set is restored to its predecessor
  and the fan-out halts. Fix the host or the image and promote newer Freight.
- **`cd-topology-station-mismatch`**: a Camp record names another Station.
  Leave `stationId` empty or match `HOBO_STATION`.
- **`cd-topology-duplicate-camp`**: two topology files declare the same Camp.
  Drop one.
- **`delivery-module-invalid` / `delivery-module-unreadable`**: the
  `--file` module has an unknown export or a malformed record; nothing was
  applied. Fix the named record and re-run.
- **`agent-jwk-invalid`**: `agent enroll` takes the PUBLIC JWK; a key with a
  private member `d` is refused.
- **`cd-not-found`**: the named Freight, pipeline, Camp or decision does not
  exist; the remediation names the list command.
- Any other code comes from the owning `@hobo/cd` module; its remediation is in
  the envelope and in that module's README.
