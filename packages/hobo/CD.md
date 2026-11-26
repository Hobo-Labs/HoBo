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
| Credential locators | `owner://NAME` from the owner store session (HoBo MCP `choose_secret_store`), and `github-app://<owner>/<repo>`: an installation token the session mints for that repository from HoBo's GitHub App (`HOBO_CI_GITHUB_APP_ID` and `HOBO_CI_GITHUB_APP_PRIVATE_KEY` in the store's relay folder, written when the owner creates the App with its `ci app create` command); each resolved for one use, never stored; anything else, `env://` locators included, is refused | any `CredentialResolver` |

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
  optional `logicalId`, `regions`, `labels`, `stationId`, `management`). The
  physical `campId` must belong to `yardId`; `logicalId`, when supplied,
  preserves the CD identity used by pipelines and the journal across a move
  to another Yard. Without it, CD uses `campId`. CD keeps the physical ID
  alongside the logical alias and refuses duplicate physical Camps, including
  declarations loaded from different topology sources. Examples include the runner
  fleet's
  [`packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts`](../ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts)
  (one Camp per runner host, `hobo-ci-runners/<host>`) and the **release
  topology**
  [`release/hobo-release.delivery.ts`](../../release/hobo-release.delivery.ts)
  (provider Yards `hobo-release-npm`, `hobo-release-oci`, `hobo-release-pages`;
  each Camp's physical id is `<yard>/<family>-<channel>` while `logicalId`
  keeps `hobo-release/<family>-<channel>` for pipelines and journal, see
  [release channels](#hobo-releases-through-hobo-cd)).
  [`test/release-provider-yards.test.ts`](../../test/release-provider-yards.test.ts)
  asserts each provider stays in its own Yard while logical Camp IDs stay stable.
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
| all | `hobo.cd/credential-ref`: the one locator the resolver may use (`owner://NAME`, or `github-app://<owner>/<repo>` for GitHub); nothing else is resolved for the Camp. Optional `hobo.cd/realize-mode`: `converge` (default) or `observe` (resolver `read` only, never a write) | |
| npm | `hobo.cd/npm.registry` (`npmjs`, `github-packages`, `https://` origin), `hobo.cd/npm.auth` (`token`, `oidc-trusted-publishing`, or `anonymous` for an observe-only Camp that resolves no credential), `hobo.cd/npm.provenance: required`, optional `hobo.cd/npm.dist-tag` | `PACKAGE` artifacts named `<package>@<version>`, optional `<name>.sigstore` bundle, label `hobo.cd/npm.dist-tag` |
| oci-registry | `hobo.cd/oci.registry` (host), `hobo.cd/oci.auth-realm`, `hobo.cd/oci.username` (non-secret), optional `hobo.cd/oci.tags` | `OCI_IMAGE` artifacts with a `<host>/<repo>@<digest>` coordinate on that host (already there, or every blob in the artifact store: the realizer pushes them on a byte transport), label `hobo.cd/oci.tags`, optional `hobo.cd/oci.mount-from` (a repository on that host to cross-mount blobs from) |
| github | `hobo.cd/github.repository` (`owner/repo`), `hobo.cd/github.pages.branch`, `hobo.cd/github.pages.path` | a `STATIC_ASSETS` `hobo.static-site-tree/v1` index (its file blobs in the store), label `hobo.cd/github.commit-message` |

GHCR OCI Camps allowlist `pkg-containers.githubusercontent.com` for cross-repository blob redirects. Release Freight (`scripts/ci/create-github-release.mts` `openReleaseCd`) maps each camp's `github-app://<owner>/<repo>` locator to the workflow job `GITHUB_TOKEN` for that repository.

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

After a restart, any `hobo cd` subcommand given `--relay` and the relay's https
origin (or HoBo MCP's `relay_login`) signs in to the owner's already configured CI relay with one
GitHub confirmation and resolves `github-app://<owner>/<repo>` and
`owner://HOBO_CI_ACCOUNT_TOKEN` through it for that process only; `--relay` is
taken off the arguments before the subcommand parses them. Long-lived provider
entries (a Vercel or Hostinger token) are not handed out by the relay, so the
steps that read them still need the owner's store session
([CI.md](CI.md#reconnect-after-a-restart-hobo-login---relay)).

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

The pinned Git source reader is a building block for source delivery. It reads
literal repository-relative paths from a full commit ID, ignoring checkout edits
and untracked files. It rejects unsafe paths, symlinks, submodules, missing Git
objects, and snapshots above its file-count or byte limits; it does not fetch
missing objects. Reading a snapshot does not deploy it.

The reader gives Git a minimal environment: the executable search path, the
Windows system root when needed, and an explicit Git discovery ceiling when
configured. Owner-session values are not inherited. Global and system Git
configuration are disabled, so a `safe.directory` exception defined only there
does not apply; read the repository as its owner or make it accessible without
that exception. The synthetic environment-isolation and missing-object tests
currently skip Windows; that platform's behavior remains unverified.

Vercel source preparation reads that pinned snapshot and produces a deployment
manifest plus content-addressed upload bytes. The manifest uses file uploads
without a Git-connected Vercel project; production plans require a new build,
disable automatic domain assignment, and include an operation identifier.
Optional archives are gzip-compressed tar files with the
`.vercel/source.tgz.part1` marker. If an archive exceeds the 32 MiB request
limit, the plan falls back to individual files, each still subject to that
limit. Preparation does not call Vercel or authorize an upload, build,
promotion, or rollback. Archive extraction and [emulator checks](../providers/provider-vercel/README.md#deployment-test-emulator)
use synthetic fixtures and do not establish live provider behavior. The
emulator caps aggregate file content at 32 MiB, so it can refuse an
individual-file fallback plan even when each upload is within the request limit.
Production dispatch still needs a durable, owner-authorized boundary and a
request-bound terminal outcome.

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

The mount and the passes are `composeCdHost` (`src/cd-host.ts`), which
`serve cd` runs behind `node:http` with the service's own tick loop. A
platform function with no loop uses the same host: `handle` answers one
request, and `pass` reconciles each MANAGED Camp once and runs one tick.
Built with `readiness: "composed"` (the Vercel host), its `/readyz`
answers 200 only when the journal's durable pass record — a
`host.PassSucceeded` event on the `cd-host-pass` stream whose `campIds`
match the current managed camps — is fresh within the readiness window
and a live journal probe succeeds. A function never starts the service's loop, so
readiness is read from the journal every request, never from a
process-local latch; any function instance sees the same record. With
`fleetPassLease`, one holder at a time claims the shared fleet pass
lease for the pass, with a lease TTL strictly greater than the pass
deadline so the lease never expires mid-pass.

## HoBo Releases Through HoBo CD

HoBo's own release train (`.github/workflows/release-hobo.yml`) maps the
release-candidate and GA classes onto `@hobo/cd` Camps, records every
artifact as Freight with provenance, and lets the Camps' realizers publish
([`hobo deploy`](#hobo-deploy)).

The topology is delivery-as-code:
[`release/hobo-release.delivery.ts`](../../release/hobo-release.delivery.ts)
declares the Yard `hobo-release` with a candidate and a stable Camp per
artifact family and one pipeline per family (`hobo-release-<family>`,
`candidate` -> `stable`, all at once, one HTTP probe per node). Any CD command
reads it with `--yard release/hobo-release.delivery.ts`; `hobo deploy pipeline
apply --file release/hobo-release.delivery.ts` applies the pipelines.

| Family | Camps | Provider (realizer) | Target and credential | What the realizer does |
|---|---|---|---|---|
| `oci` | `hobo-release/oci-candidate`, `oci-stable` | `@hobo/provider-oci-registry` | `ghcr.io`, the workflow `GITHUB_TOKEN` (`env://GITHUB_TOKEN`) | candidate: pushes the image from the HoBo artifact store (config and layers uploaded, or mounted from the toolchain image's repository; the manifest PUT by digest with its exact bytes; then the release tag) and observes digest and tag; stable: re-observes |
| `pages` | `hobo-release/pages-candidate`, `pages-stable` | `@hobo/provider-github` | this repository's `gh-pages` branch, `GITHUB_TOKEN` (`contents: write`) | candidate: uploads missing blobs, creates the tree (id computed before upload) and one commit `deploy: <sha>` on the observed head, moved by compare-and-swap; stable: re-observes the tree and its Pages build |
| `npm` | `hobo-release/npm-candidate`, `npm-stable` | `@hobo/provider-npm` | `registry.npmjs.org`, the hobodev token (`env://NPM_TOKEN`), provenance required; stable reads anonymously (`none://npm-public-read`) | candidate: publishes each version with its Sigstore provenance bundle attached and the release dist-tag, and observes both; stable: re-observes without a credential |

Candidate Camps converge; stable Camps declare `hobo.cd/realize-mode:
observe`, so their realizer only calls the resolver's `read` (pull-only token
scope) and never writes. The stable passes run in the tag and GitHub Release
jobs, whose `GITHUB_TOKEN` has `contents: write` and no `packages`
permission: they never ask GHCR for push scope, and a target that drifted
after candidate blocks stable instead of being repaired there.

The steps are the `hobo deploy` subcommands, run through the `hobo` package's
own CD composition (`openCdRuntime` with the release topology, as `--yard`
loads it). That package is built once per run, by the `release-hobo-cli` job
(`turbo run build --filter=@hobo/hobo...`, `contents: read`, no release
secret, no Turbo cache another run wrote), and only for a run that publishes
or promotes (the main train releases, Pages is stale, a release tag, or a
dispatch that pushes images). It runs on the GitHub-hosted `ubuntu-24.04`
runner, like the npm job: the npm job runs this CLI while it holds the OIDC
token whose provenance names a GitHub-hosted builder, so no self-hosted runner
produces code that runs inside the signing job. It packs the `dist/` of every
package in turbo's build closure with a manifest naming the commit it was
built from (`scripts/ci/release-freight-cli.mts pack`), and its `digest`
output is that archive's sha256. Every release job that runs `hobo deploy`
(GHCR publish, npm publish, Pages, the tag and GitHub Release jobs) needs
`release-hobo-cli` to succeed and restores the archive only when its sha256 is
that digest and its revision is the commit the job checked out; anything else
fails the job. Building the closure in each of them had run every one past the
20-minute job limit. The npm job still builds and packs the tarballs it signs
itself; only the CLI it promotes them with comes from the artifact. The
pull request's offline realize proof is its own `release-realize` job, which
restores the Turbo cache, builds `@hobo/hobo` and runs the realize test; the
release PR gate requires it, so a cache miss on that build never runs the
release contract's image builds past their limit.

1. `freight record`: the manifest names each artifact by sha256 digest, the
   release commit, the run id and the workflow as builder, and a declaration
   (a Bindle with one resource on the family's product) under its canonical
   hash. Tarballs, their Sigstore bundles and the Pages tree go into the HoBo
   artifact store first. A built GHCR image is exported as an OCI image layout
   (`docker save`, `exportReleaseOciLayout`); every blob goes into the store
   and the root digest is recorded at its GHCR coordinate (`ecosystem:
   store`). A release tag already on GHCR for this build is reused and
   verified at the registry instead. A refusal stops the job.
2. `pipeline apply --file release/hobo-release.delivery.ts`.
3. `promote <freight> --camp hobo-release/<family>-candidate --pipeline
   hobo-release-<family> --node candidate`, then in the tag jobs (or the Pages
   job) the same into `<family>-stable` with `--source-camp`. Each promotion
   is driven the way `hobo serve cd` ticks it (promotions, one conductor pass
   of the Camp, rollouts, verification) until it is PROMOTED or the realizer
   reports BLOCKED. The journal (`HOBO_RELEASE_CD_HOME`) travels between jobs
   as the `hobo-release-freight-<family>` artifact, so `@hobo/cd` enforces the
   candidate -> stable lineage itself.

The verdict is `qualified` (PROMOTED: the realizer converged by its own
observation and the node's probe passed) or `blocked`. Every realizer
refusal blocks, including `npm-provenance-bundle-missing` (a tarball whose
Sigstore bundle the Freight does not carry), `npm-oidc-scoped-unsupported`,
a generic `RESOLVER_PRODUCT_UNSUPPORTED` and `catalog-binding-invalid` (a
missing or invalid Camp label, or a package artifact not named
`<package>@<version>`), and so does not finishing. There is no fallback
publisher: no `npm publish`, no `docker push`.

How each family publishes:

- **npm.** `scripts/ci/publish-npm-sdk.mts` signs each staged tarball's
  provenance keyless in the `release-npm` job (`@hobo/cd/provenance`
  `signNpmProvenance`: npm's GitHub Actions in-toto statement with the
  tarball's sha512 and sha256, a Fulcio certificate for the job's OIDC
  identity, a Rekor entry). The bundle is recorded next to its tarball as
  `<package>@<version>.sigstore`; the realizer binds it to the tarball's
  sha512 and attaches it to the publish, and npmjs verifies it. Auth is the
  hobodev token: npm's OIDC exchange routes only for the `%2f`-escaped scope,
  which the transport guard refuses, so a scoped name cannot use trusted
  publishing through the realizer. The bundle is not a Freight
  `ProvenanceRef`: a pushed manifest's provenance is unverified by design,
  and the trust gate refuses unverified provenance.
- **OCI.** `scripts/ci/push-release-ghcr-images.mts` builds the image,
  exports it as an OCI layout and records it; the realizer runs on a byte
  transport (`ociLatin1Transport`: binary bodies bypass the UTF-8 host
  transport) and pushes config and layers (monolithic up to 32 MiB, `CATALOG_OCI_CHUNK_BYTES`, chunked
  past it), the manifest by digest with its exact bytes, then the tag. A
  cross-repository mount from the toolchain image's repository is tried
  first; a mount GHCR or the token declines is uploaded. The digest recorded
  as Freight is the digest GHCR serves: the registry recomputes it from the
  bytes the realizer PUT, and the realizer refuses anything it does not
  observe there.

Remaining gaps and limits:

- **Not yet run live.** Both publishers are proven offline against the
  providers' recorded registry worlds (`scripts/test/release-freight-realize.test.ts`);
  the first live npm publish still waits on `HOBO_NPM_PUBLISH` and the
  hobodev `NPM_TOKEN`. The export refuses a Docker daemon older than 25
  (`dockerOciSaveSupport`: older `docker save` writes no OCI layout). On a
  runner without the containerd image store, `docker save` writes
  uncompressed layers, so the pushed image is larger and its layers are not
  mountable from the toolchain repository; the export warns, and the image
  is still correct by digest.
- **Pages history.** The Pages realizer commits on the observed head instead
  of force-pushing an orphan commit, so `gh-pages` keeps one commit per
  deploy. Blobs are shared by content, so each commit adds only the files
  that changed (hashed `_astro/` bundles, regenerated pages), but the branch
  and a full clone of it grow without bound. Nothing prunes it yet; resetting
  the branch to a single orphan commit is a manual operation (the next deploy
  commits on whatever head it observes).
- **Pages upload rate.** Each new blob is one `POST /git/blobs`, which counts
  against GitHub's secondary limit on content creation (80 per minute, 500 per
  hour). The catalog realizer looks each blob up first (`GET`, outside that
  limit) and remembers the blobs GitHub acknowledged across passes, so a
  repeat pass or a re-run uploads only what GitHub does not hold yet. A deploy
  that changes more than about 75 files at once (a full rebuild of the about
  290-file site) can still hit the limit: that pass blocks with the
  provider's rate-limit refusal and fails the release, and re-running the job
  continues from the blobs already uploaded.

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
