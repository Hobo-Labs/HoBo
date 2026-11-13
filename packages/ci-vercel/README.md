# HoBo CI Vercel support

## Run Vercel CI checks locally

`@hobo/ci-vercel/turbo-ci` runs the checks declared for the new Vercel CI
runtime on a developer machine or a HoBo-owned runner. The existing HTTP relay
and Sandbox integration are described below.

Vercel CI selects tasks with `"tags": ["ci"]` in `turbo.json`. HoBo asks Turbo
for those resolved task tags, honors `!ci`, package overrides and
`$TURBO_EXTENDS$`, then runs the exact `package#task` entrypoints. Turbo owns the
dependency graph, input hashes, strict environment filtering, outputs and cache.
A dependency tagged `!ci` still runs when a selected check requires it. Package
labels alone do not opt tasks into CI.

From this repository's root:

```sh
pnpm ci:local --dry-run
pnpm ci:local
pnpm ci:local --affected --base origin/main
```

The checked-in [package configuration](turbo.json) initially selects only this
package's `test` and `typecheck`. Other packages can opt in with the same task
tags. This does not enable hosted CI or any GitHub Actions workflow.
The local runner requires Turbo >=2.11.10 <3; the root dependency is pinned to
2.11.10 because the planner consumes its GraphQL task metadata. Vercel's own
documented minimum is Turbo 2.11.7. Recheck the CLI contract before upgrading.

For another checkout, use `pnpm ci:local --cwd /path/to/repository`. Dependencies
and the repository's Turbo version must already be installed. The SDK exposes
`planTurboCi({cwd})` and `runTurboCi({cwd, signal})`; after building the package,
`pnpm --filter @hobo/ci-vercel ci:local --cwd /path/to/repository` uses its CLI.

`--affected` requires an explicit `--base` and sufficient Git history; `--head`
defaults to `HEAD`. The planner intersects CI entrypoints with Turbo's
input-aware `affectedTasks` query **before** emitting explicit selectors.
Appending `--affected` to qualified selectors does not narrow them in Turbo
2.11.10. Invalid refs fail planning. The default runs every tagged check and
lets Turbo reuse matching cached results. An empty selection succeeds without
starting a task runner. Dry runs query and inspect the graph but execute no checks.

Local cache is the default (`--cache=local:rw`), even for a checkout linked to
Vercel Remote Cache. `--remote-cache` explicitly enables both local and configured
remote cache reads/writes. That can share results with Vercel or another cache
server, subject to input/environment/platform compatibility and provider terms.
It does not change where checks execute. Each invocation uses
`--concurrency=100%` and `--continue=never`, streams task logs, returns Turbo's
exit code, and asks Turbo to stop its task process groups on cancellation. The
CLI continues handling repeated interrupts until shutdown completes. POSIX hosts are
required. Run only trusted checkout code: this is not an isolation boundary.

### Billing and runtime boundaries

As checked October 29, 2026, the [Vercel CI documentation](https://vercel.com/docs/ci)
and [CLI reference](https://vercel.com/docs/cli/ci) document hosted push-triggered
execution, not a self-hosted runner registration or local `vercel ci run`.
HoBo executes the same Turbo checks locally; it does not impersonate a Vercel
worker or publish Vercel CI success checks.

To avoid Vercel CI compute charges, keep hosted Vercel CI disabled in that
repository's Vercel settings. Tagging tasks does not itself enable it. If CI is
already enabled, turn it off there; a local run does not disable it. Configure
branch protection to require the actual HoBo/GitHub check when using the existing
[Actions relay](../ci-gh-actions/README.md) for automated checks. A local success
does not satisfy a required Vercel CI status.

[Vercel CI pricing](https://vercel.com/docs/ci/pricing) bills bootstrapping as
well as executed tasks. Warming the remote cache can avoid task CPU minutes but
does not guarantee a free hosted invocation. This runner makes no Vercel API
calls and uses no Vercel compute. Commands inside checks, remote caches, the
separate relay, Sandbox runners and deployments may still incur their own costs.

Vercel CPU/image tags describe cloud resource choices; local checks use the
caller's OS and installed tools. HoBo does not reproduce Vercel's per-task VM
isolation, bootstrap snapshots, project secrets, deployment waits or OIDC header
injection. Persistent tasks, managed OIDC tags (including package defaults) and
virtual `#deployment` dependencies are refused before execution. An explicit
`ci:oidc:none` task override is supported. Supply local test services and ordinary
environment variables through existing Turbo `env`/`passThroughEnv` declarations;
keep cloud-only deployment checks on their intended runtime.

### Local runner gates

`test/turbo-ci.test.ts` exercises real Turbo processes for tag inheritance,
opt-outs, required dependencies, cache restoration, affected roots, failures,
cancellation and cloud-feature refusals. `test/turbo-ci-cli.test.ts` verifies empty
dry-run JSON and repeated interrupts against the real CLI. The CLI consumer PACT in
`contracts/turbo-ci.consumer.test.ts` verifies the metadata contract against the
installed binary without Vercel credentials. TypeScript covers the SDK and CLI.
The runner hands the caller's environment, `TURBO_CACHE_DIR` and remote-cache
settings included, to Turbo, so both runner suites drop inherited `TURBO_*`
variables (`test/isolated-turbo-env.ts`): their fixtures hash identically in every
temp dir, and the shared CI cache would otherwise replay a task instead of running
the script the test observes.
The plan uses generated [Protobuf](data-models/turbo_ci.proto), with independent
[CUE constraints and fixtures](data-models/turbo-ci/plan.cue). Check codegen with
`pnpm codegen:check --filter packages/ci-vercel`; run `cue vet -d '#TurboCiPlan'
packages/ci-vercel/data-models/turbo-ci/plan.cue <fixture.json>` for each plan
fixture (invalid fixtures must fail). Plan fixtures are separate from queue
fixtures because schema-tools applies every top-level CUE schema to that
directory's entire fixture corpus.

Planning is an ephemeral query, not a new durable relay command. It does not
write relay events or projections. Turbo persists its ordinary local task cache;
the generated plan is printed by `--dry-run` and is not accepted as executable
input. The relay's own commands and events are independent of it.

## The relay as a HoBo app

HoBo deploys its own relay, so the relay is declared in HoBo's own app model.
[`src/bindle.ts`](src/bindle.ts) is the Bindle (`hobo-ci-relay`), at the path the
CLI's project loader looks for (`src/bindle.ts`), so this directory is a HoBo
project. Since ADR-0179 phase 4b it declares no database:

| Resource | Kind | What it is here |
|---|---|---|
| `relay` | `api` | the HTTP entry, `api/relay.ts`, which every route is rewritten to |
| `hobo-ci` | `queue` | repair ticks, consumed by `api/queue.ts` |
| `hobo-ci-intake` | `queue` | verified webhook deliveries, consumed by `api/intake.ts` |
| `hobo-ci-lease-steps` | `queue` | delayed per-lease steps, consumed by `api/lease-steps.ts` |
| `hobo-ci-repair` | `schedule` | the repair tick, every 15 minutes, onto `hobo-ci` |
| `cache` | `kv` | short-lived job state the relay may lose and rebuild (`get`, `set`, `delete`) |
| `config` | `secret` | the config service: the config document and the relay's secrets, read only (`access`) |

`hobo ci deploy` plans from the relay's Yard and Camps ([below](#the-relays-yard-and-camps)) instead of hardcoding Vercel (phase 6).

The Bindle names no provider (`assertNoBindleProviderSelection` holds, and the
test below also scans the declaration for provider and product names): the
target is chosen where the deploy is run. Facts the Bindle model cannot carry
yet are exported beside it, keyed by its resource names: `RELAY_REPAIR_SCHEDULE`
(the cadence `*/15 * * * *`; `b.schedule()` takes none), `relayCache`
(`redisCompatible.store({ ttl, atomicIncrement, atomicCompareAndSet })` from
`@hobo/kv-redis-compatible`, a `kv.redis-compatible/v1` capability requirement;
`b.kv()` takes none) and `relayConfigService` (read-only, workload identity, a
config document and secrets, refreshed at most once a minute). `relayConfig`
is the relay's `config()` schema: every setting the deployed code reads, by
name and with no value. Its `env.*` fields are the non-secret configuration a
deploy may set; its `secret.*` fields (`CRON_SECRET`, the session key, tokens,
the GitHub App key and secrets, the Sandbox proxy token key) are named only:
the config service holds them. The cache's coordinates are its binding's
(below), not settings here. Phase 6 binds these resources in a Yard and Camp.

The declaration is not deployed code. No entry file and no other source imports
it, and the package's build (`tsconfig.json`) leaves it out, so what Vercel
compiles and bundles for the relay is unchanged and needs neither
`@hobo/bindles` nor its requirement builders at run time; `tsconfig.check.json`
type-checks it.

`test/relay-bindle.test.ts` ties the declaration to the relay so it cannot
drift: each queue topic and its consumer file equal `vercel.json`'s queue
triggers, the topics equal `RELAY_QUEUE_TOPICS` (no source sends to a literal
topic), the route destination equals the HTTP entry, the repair name equals
the schedule's, and the declared settings are exactly the `HOBO_CI_*` and
`CRON_SECRET` names the deployed code reads: the sources the entry files reach
through their imports. `test/relay-bundle.test.ts` bundles the entry files the
way a deployment does and fails if the bundle reaches `pg`, `@neon/functions`
or `@hobo/data-postgres`.

### The relay's Yard and Camps

The Bindle says what the relay is; [`deploy/yard.ts`](deploy/yard.ts) says where
it runs and what may be bound to it there
([ADR-0157](../../docs/design/adr/07-portability-extensibility.md#adr-0157): the
Yard is the binding authority). It is the one place the provider is named.

- **Yard `hobo-ci-relay`**: provider `vercel`, region `iad1`, properties
  `project: hobo-ci`, `repository: Hobo-Labs/HoBo`,
  `rootDirectory: packages/ci-vercel`.
- **Camps**: `production` (what a merge to `main` deploys) and `preview` (the
  default of a deploy run by hand). Each lists the capability profiles its
  environment requires; for each, the first row in canonical order is chosen
  (ADR-0151: hard gates, then lexicographic order).

| Profile | Offering | Attached by | In Camp |
|---|---|---|---|
| `provider.project/v1` | `vercel.project/v1` (`rootDirectory`) | the deploy | both |
| `api.http/v1` | `vercel.function/v1` (`api/relay.ts`, 300 s) | the git deployment | both |
| `service.queue-consumer/v1` | `vercel.function/v1` (`api/queue.ts`, topic `hobo-ci`) | the git deployment | both |
| `queue.at-least-once/v1`, `queue.delay/v1` | `vercel.queues/v1` (topic `hobo-ci`) | `vercel.json` | both |
| `service.scheduled/v1` | `vercel.schedules/v1` (`hobo-ci-repair`, `*/15 * * * *`) | `vercel.json` | both |
| `kv.redis-compatible/v1` | `upstash.redis/v1` via `vercel.marketplace/v1` (`upstash/upstash-kv`, resource `hobo-ci-cache`) | `hobo ci deploy --provision` | both |
| `data.sqlite/v1` | `turso.database/v1` via `vercel.marketplace/v1` (`tursocloud`) | not chosen | catalog |
| `bucket.object/v1` | `vercel.blob/v1` via `vercel.oidc/v1` (store `hobo-ci-cache`, private) | not chosen | catalog |
| `kv.valkey/v1` | `aiven.valkey/v1`, `valkey.self-hosted/v1` via `config-service.url/v1` (`VALKEY_URL` in the config service) | not chosen | catalog |
| `secret-ref.runtime-projection/v1` | `infisical.secrets/v1` via `infisical.oidc-auth/v1` | the deploy's settings | production |

A row's `properties.settings` are the non-secret settings it projects onto the
deployment, and `properties.inputs` the names the deploy must be given. The
config-service row projects `HOBO_CI_CONFIG_SERVICE=infisical`,
`INFISICAL_SITE_URL` and `INFISICAL_SECRET_PATH=/hobo-ci-relay`, and asks for
`INFISICAL_IDENTITY_ID` and `INFISICAL_PROJECT_ID` (the owner's ids, from
repository variables in CI); the production Camp adds
`INFISICAL_ENVIRONMENT=prod`. Preview does not choose the config service: the
relay's Infisical identity trusts production tokens only, so a preview keeps
`HOBO_CI_CONFIG_SERVICE` at its default, `env`. The rows the Camps do not choose
are the catalog: to move the cache to Valkey, a Camp requires `kv.valkey/v1`
instead (the relay's config loader must then accept `VALKEY_URL`, which it does
not yet). No row holds a credential: the Marketplace integrations write their
own connection variables, and the config service holds the relay's secrets.

Like the Bindle, the Yard is a declaration, not deployed code: nothing in `api/`
or `src/` imports it, and the build leaves `deploy/` out.
`test/relay-yard.test.ts` ties it to `vercel.json` and to the Bindle. Product ids
other than `vercel.project/v1` are this Yard's; no provider package resolves
them yet.

### Deploying the relay with HoBo

HoBo delivers its own relay: `hobo ci deploy` reads the Bindle and the Yard and
hands the relay to HoBo CD (`@hobo/cd`, [CLI](../hobo/CD.md)). It records the
commit as **Freight** (the `hobo-ci-relay` Bindle, its declaration and a source
pin of the repository, ref and commit, stored by digest in the CD artifact
store), promotes it through the relay's pipeline and the CD gate, and a
conductor reconciler realizes it on Vercel from a git ref, through HoBo's own
Vercel provider ([`@hobo/hobo`](../hobo/README.md),
`createVercelDeployProvider`'s git-artifact mode). The Set converges only once
Vercel reports the deployment READY.

The pipeline is delivery-as-code beside the Yard,
[`deploy/delivery.ts`](deploy/delivery.ts) (`hobo deploy pipeline apply --file
packages/ci-vercel/deploy/delivery.ts` applies the same records):

| Node | Camp | Takes Freight from | Verified by |
|---|---|---|---|
| `preview` | `hobo-ci-relay/preview` | the relay's HoBo CI source (`hoboSelfDeliverySources`), or pushed by `hobo ci deploy` | a probe of `$HOBO_CI_RELAY_PREVIEW_URL/healthz` (the preview Camp has no config-service binding, so its `/readyz` answers 503 and is not required) |
| `production` | `hobo-ci-relay/production` | **only** Freight `preview` qualified | probes of `$HOBO_CI_RELAY_URL/healthz` (which must name the Freight's commit) and `/readyz` |

`hobo ci deploy --adopt` verifies the same nodes differently: preview by its
deployment record, production at `$HOBO_CI_RELAY_URL` or the Yard's
`productionOrigin` ([token-free relay mode](#token-free-relay-mode-hobo-ci-deploy---adopt)).

Each probe must answer 200 on every attempt across a 60 s window; a probe that
cannot reach the relay is an unhealthy attempt, and no data fails the
verification (a node whose origin is unset probes a reserved `.invalid` host).
PASS is the only qualification. **A failed verification fails the promotion
and the job; it does not roll anything back.** The deployment that failed
stays live on Vercel: CI's journal is job-scoped, so a production Camp there
never has a predecessor Set to restore, the command returns as soon as the
promotion is terminal, and there is no Vercel rollback realizer (no redeploy or
re-alias of the previous deployment). Roll back by hand (`vercel rollback`, or
promote the previous deployment in the dashboard).
`hobo ci deploy --target production` needs `--sha` and is refused, before
anything is sent, when preview has not qualified that commit
(`HOBO_CI_DEPLOY_NOT_QUALIFIED`). `--wait` drives the promotion to its end;
without it the command returns once the deployment exists, unverified. The
result keeps its JSON contract (`code`, `data.outputs`, `data.plan`) and adds
`data.delivery` (pipeline, node, Camp, Freight, promotion and its state).

Known gaps, stated rather than hidden:

- **Preview on the by-hand token path reads a fixed origin.** `/healthz`
  names the build's commit (`VERCEL_GIT_COMMIT_SHA`), and production on both
  paths requires it to equal the Freight's commit, so a stale deployment
  behind `$HOBO_CI_RELAY_URL` no longer qualifies a newer commit
  (`HOBO_CI_DEPLOY_COMMIT_MISMATCH`). The by-hand preview probe of
  `$HOBO_CI_RELAY_PREVIEW_URL` (a branch alias) does not check the commit yet;
  `--adopt` verifies preview by its deployment record instead.

The journal is the shared CD journal: `$HOBO_HOME/cd`, or the store
`HOBO_CD_SQLITE_PATH` / `HOBO_CD_POSTGRES_URL` names, the same one
`hobo deploy` and `hobo serve cd` read. `@hobo/cd` stores the rollout ledger
under the durable `rollout.*` family and folds the reconcile status envelope
itself, so the relay's promotions are ordinary CD records: `hobo deploy logs
--camp hobo-ci-relay/hobo-ci-relay/production --yard
packages/ci-vercel/deploy/yard.ts` shows them.

#### Contract changes of `hobo ci deploy`

Delivering through HoBo CD changed the verb for anyone who runs it by hand:

| Before | Now |
|---|---|
| `--wait` waited for READY | `--wait` waits for READY, then verifies and qualifies; it needs the target's probe origin (`HOBO_CI_RELAY_PREVIEW_URL` or `HOBO_CI_RELAY_URL`) and is refused without it (`HOBO_CI_DEPLOY_VERIFY_ORIGIN_UNSET`) |
| `--target production` deployed any ref | it needs `--sha`, and preview's qualification of that commit in the same journal (`HOBO_CI_DEPLOY_NOT_QUALIFIED`) |
| a 15-minute wait | a 20-minute wait; `HOBO_CI_DEPLOY_NOT_READY` also covers a rollout deadline |
| — | new codes: `HOBO_CI_DEPLOY_INCOMPLETE`, `HOBO_CI_DEPLOY_VERIFICATION_FAILED`, `HOBO_CI_DEPLOY_NOT_QUALIFIED`, `HOBO_CI_DEPLOY_SOURCE_UNPINNED`, `HOBO_CI_DEPLOY_DELIVERY_UNAVAILABLE`, `HOBO_CI_DEPLOY_DELIVERY_INVALID`, `HOBO_CI_DEPLOY_FREIGHT_REFUSED`, `HOBO_CI_DEPLOY_PROMOTION_REFUSED` |

**Production is deployed by CI, not by hand**:
[`.github/workflows/relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)
runs on every push to `main` that changes this package or a workspace package
it is built from (its pnpm-lock closure, `scripts/ci/relay-deploy-gate.mts`),
and on `workflow_dispatch`:

0. A `route` job picks the runner first, as `hobo-ci.yml` does (the fleet
   while it takes jobs, an enrolled box, else GitHub-hosted).
1. The gate ends the job with a notice, and success, until a secret store is
   bound to the relay: `deploy/secret-store.binding.json`, coordinates only,
   which `hobo ci secret-store provision` writes when the HoBo deployment
   chooses the store and the owner claims it, or `hobo ci secret-store connect`
   writes from the ids of a secrets manager the owner connected with OIDC
   ([secretless first](CONFIG-SERVICE.md#the-relays-store-today-secretless-first);
   [Config service](CONFIG-SERVICE.md#where-the-store-comes-from-chosen-at-deploy-handed-over-by-claim)).
   No repository variable or secret is read.
2. *Verify the secret store connection*: with `permissions: id-token: write`
   the job signs in to the store as `hobo-ci-writer` (GitHub OIDC; sign-in
   only — role shape not asserted), then revokes the token, and reports it pass or
   fail by name (`hobo ci secret-store verify`).
3. *Adopt Vercel's Git deployment of this commit*: Vercel's Git integration
   deploys `hobo-ci` on the push (no Vercel token anywhere, no Vercel API
   write), and `hobo ci deploy --adopt --sha "$GITHUB_SHA"` adopts it
   ([token-free relay mode](#token-free-relay-mode-hobo-ci-deploy---adopt)):
   it reads the deployment from GitHub's Deployments API with the job's own
   `GITHUB_TOKEN` (`deployments: read`), records it as relay Freight and
   promotes it through HoBo CD preview then production, failing closed:
   preview by its deployment record, production at the Yard's production
   domain (`/healthz` names the commit, `/readyz` answers 200). The command's
   exit status is the step's.

A manual run given a GitHub App manifest code (`hobo ci app create
--via-workflow` dispatches it) runs only the `app-credentials` job instead:
it masks the code and runs `hobo ci app deposit`, which converts it and
writes the App's credentials into the store as `hobo-ci-writer`
([secretless first](CONFIG-SERVICE.md#the-relays-store-today-secretless-first)).

In production the relay reads its store's coordinates from the committed
binding (bundled through `vercel.json` `includeFiles`), and derives its
session key, Sandbox proxy key and `CRON_SECRET` from the App private key
(`src/relay-derived-keys.ts`).

#### Token-free relay mode (`hobo ci deploy --adopt`)

The workflow holds no Vercel token, so it does not deploy: it adopts.
`hobo ci deploy --adopt --sha <commit>` is a publisher with an observe-only
realization:

1. **Find.** It reads `GET /repos/{owner}/{repo}/deployments?sha=<commit>` and
   each record's statuses from GitHub's API, through a transport guarded to
   `api.github.com` and that repository's deployments, GET only, for up to 15
   minutes. The token is the credentialRef `env://GITHUB_TOKEN`, resolved by
   the CD `CredentialResolver` for each request; it is never recorded, logged
   or returned. The deployment adopted is the Yard project's (`hobo-ci`)
   `Production – hobo-ci` record of that exact commit, once a status names its
   URL (`@hobo/provider-vercel` `vercelGitDeploymentRecords` /
   `vercelGitDeploymentStatus`). None in time: `HOBO_CI_ADOPT_NOT_FOUND`, and
   nothing is recorded.
2. **Record.** The relay Freight's source pin holds the commit and the adopted
   deployment: GitHub's deployment record id (GitHub carries no Vercel `dpl_`
   id), its URL, its state when adopted, and Vercel's inspector URL when
   reported.
3. **Promote.** The Freight goes through the relay pipeline, preview then
   production, in the shared CD journal. The conductor's realizer never creates
   a deployment: it re-reads the record and its statuses and converges only
   when the deployment is READY **and** is the deployment of the Freight's
   commit (`vercelAdoptionVerdict`); ERROR, superseded (`inactive`) or another
   commit is blocked (`HOBO_CI_DEPLOY_NOT_READY`, the state in the message).
4. **Verify**, fail closed, without ever probing the per-deployment URL
   (`hobo-ci-<hash>.vercel.app` answers 401 under Vercel Deployment
   Protection, and no bypass secret is held):
   - **production** probes the production domain: `$HOBO_CI_RELAY_URL` when
     set, else the Yard's `productionOrigin` (`deploy/yard.ts`,
     `https://hobo-ci.vercel.app`), which Standard Protection leaves public.
     `/healthz` must answer 200 **and** name the Freight's commit (the relay
     reports `VERCEL_GIT_COMMIT_SHA`, `src/entry.ts`); `/readyz` must answer
     200. Every attempt in the window must pass. The commit match is what
     proves the domain serves the adopted deployment rather than an older one.
   - **preview** has no unprotected URL (Vercel exempts no GET path from
     protection), so it is verified by the deployment record: the suite
     `vercel.git-deployment.ready` re-reads GitHub's record at the end of the
     window and passes only when the deployment is READY and is the
     deployment of the Freight's commit.

A production verification that fails ends the command with its reason, read
from what the production domain answered, and CD records the promotion's end
in the journal (its compensation restores the predecessor Set there):

| Code | The production domain said | Remediation in the message |
|---|---|---|
| `HOBO_CI_DEPLOY_COMMIT_MISMATCH` | `/healthz` names another commit, or none | which deployment Vercel aliased to production; the right origin |
| `HOBO_CI_DEPLOY_RELAY_NOT_CONFIGURED` | `/readyz` `state: "not-configured"` | fill the store `deploy/secret-store.binding.json` names ([folder](CONFIG-SERVICE.md#what-the-folder-holds)) |
| `HOBO_CI_DEPLOY_RELAY_NOT_READY` | `/readyz` `config-service-denied`, `config-service-unavailable`, `start-failed`, a started relay's false parts, or `/healthz` not 200 | per reason |
| `HOBO_CI_DEPLOY_VERIFICATION_FAILED` | anything else | — |

With neither `$HOBO_CI_RELAY_URL` nor a `productionOrigin`, the command is
refused before it reads anything (`HOBO_CI_ADOPT_ORIGIN_UNSET`). Nothing is
rolled back or changed on Vercel: the realization has no write to do it with.
Other deploy options (`--set`, `--provision`, `--target`, ...) are refused with
`--adopt`; it takes `--sha`, `--repo` and `--ref` only. No `GITHUB_TOKEN`:
`HOBO_CI_ADOPT_AUTH_REQUIRED` (it never reads `VERCEL_TOKEN`).

Stated, not hidden: `/readyz` answers 503 until the relay can read its store,
so production does not qualify until the store's folder is filled (the old
smoke check only reported it); it says so as `HOBO_CI_DEPLOY_RELAY_NOT_CONFIGURED`.
A deployment built before `/healthz` reported its commit fails as
`HOBO_CI_DEPLOY_COMMIT_MISMATCH` ("names no commit"); the first push that
carries this change qualifies once Vercel serves it. If the project is set to
protect all deployments (not Standard), the production domain answers 401 too
and the message says so. Exercised against recorded-shape GitHub answers, fake
probes and a temporary journal (`packages/hobo/test/ci-relay-adopt.test.ts`);
no live adoption has run.

HoBo CD delivery with a deploy token stays the by-hand path below.

By hand, for a preview or to read a plan:

```sh
# From the repository root: print the plan; nothing is sent, no token is read.
hobo ci deploy --cwd packages/ci-vercel --ref main --team team_… \
  --set HOBO_CI_PUBLIC_URL=https://… --dry-run

# A real run reads VERCEL_TOKEN from the environment. Preview is the default.
VERCEL_TOKEN=… hobo ci deploy --cwd packages/ci-vercel --ref <branch> --team team_…

# Verify and qualify it (needs HOBO_CI_RELAY_PREVIEW_URL), then promote it
# (preview's qualification is read from the same CD journal, so keep HOBO_HOME).
VERCEL_TOKEN=… HOBO_CI_RELAY_PREVIEW_URL=https://… hobo ci deploy \
  --cwd packages/ci-vercel --ref main --sha <commit> --team team_… --wait
```

It needs a Vercel access token for the project's scope and Vercel's GitHub
integration able to read the repository. `--set` takes only the `env.*` fields
of `relayConfig` and the inputs of the bindings the Camp chooses; a `secret.*`
field, a setting the Yard already sets, an undeclared name, a storage
integration's variable or a credential-shaped value is refused before anything
is sent. It never sets `CRON_SECRET` or any other secret, and does not create
the project unless `--create-project` is given.

Matching for the relay uses the Yard's own declared catalog (a planner provider
`yard:hobo-ci-relay` advertising the ports its binding rows cover, realized
only by the git deployment), because no provider package resolves
`vercel.queues/v1`, `vercel.schedules/v1` or the Marketplace cache yet.

**Status: exercised against fakes only (a pact-backed Vercel transport, a fake
Vercel CLI, fake probe answers, a temporary CD journal, fake GitHub and
Infisical endpoints). No live deployment of the relay was made from this
repository by this change.**

## Config service

ADR-0179 (phase 3) moves the relay's configuration and secrets to a config
service: Infisical Cloud, read with the relay's Vercel OIDC token, no secret in
its environment. `src/relay-runtime-config.ts` loads the whole configuration
(the config document and every secret, App credentials included) in one call,
parses it into `RelayRuntimeConfig` with its schema
(`src/relay-runtime-config-schema.ts`), and caches it in memory for a minute;
`envRelayConfigSource` gives the same type from the environment for local runs
and tests. `entry.ts` loads it (phase 4b, [below](#the-stateless-relay)). Owner
setup, the variables the deployment declares and the folder's entries are in
[Config service](CONFIG-SERVICE.md); the client is
[`@hobo/adapter-infisical`](../adapters/adapter-infisical/README.md).

## The stateless relay

ADR-0179 phase 4b. What `api/relay.ts` and the three queue entries run is
`composeStatelessRelay` ([`src/stateless-composition.ts`](src/stateless-composition.ts)):
no database, no Neon broker, no address of either in the source. The
PostgreSQL composition, the relay database fleet and store selection, the
Neon broker and the Drizzle relay schema were deleted in phase 7. Rolling back
means promoting an earlier deployment.

**How it is composed.**

1. **Config and secrets**: `RelayRuntimeConfig` from the config service the
   deployment names (`HOBO_CI_CONFIG_SERVICE=infisical`, or `env`, the default,
   which reads the same keys from the environment for local runs and tests),
   loaded once per instance and refreshed at most once a minute; a failed
   refresh keeps the last good copy and is logged as
   `hobo_ci_config_refresh_failed`. The config document (`HOBO_CI_CONFIG_JSON`)
   and the control tokens follow each refresh; the App key, webhook secret and
   cron secret are the ones the instance started with.
2. **The cache fleet** (`src/cache-backend.ts`, `src/cache-fleet.ts`,
   phase 4c; [The cache fleet](#the-cache-fleet) below): every cache the
   deployment binds is a member, in a fixed configured order — an Upstash REST
   pair (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, then
   `KV_REST_API_URL` + `KV_REST_API_TOKEN`), `VALKEY_URL`, `REDIS_URL` (RESP
   over TCP, `ioredis` loaded only then), the Turso pair
   (`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`) and `BLOB_STORE_ID` (Vercel Blob
   by OIDC). `VALKEY_URL` and the Turso and Blob names may also come from the
   config service, for names the deployment's environment does not set. With
   none, the in-memory engine, and only off Vercel: a production or preview
   deployment with no cache refuses to start. Exactly one member is active;
   every port call goes to it. Start-up logs `hobo_ci_cache_fleet` with the
   member ids, their kinds and the variable *names* (and which came from the
   config service); no value is ever logged.
3. **The store**: `RelayCacheStore` over that cache, keys under
   `hobo-ci:<VERCEL_ENV>:` (`local` off Vercel), the config document as its
   read-only config source, the Sandbox proxy token key from the config service,
   and the step scheduler as its `onLeaseChange` hook. Every member is metered
   in the units it bills (commands, rows read and written, or simple and
   advanced Blob operations, counted at its client); at most once a minute per
   instance, and on every repair tick, the delta is added to a monthly counter
   kept on that member and logged as `hobo_ci_cache_usage` (`used`,
   `projected` for the month and `allowance`, per unit, and `overBudget`).
4. **Rebuild**: `githubRelayDiscovery` (GitHub runners, bridge runs, jobs) and
   the Sandbox host's lookup by name are the discovery ports; a lease step that
   finds no record rebuilds the lease by name, and each repair tick runs
   `rebuildInflight` for accounts whose in-flight holds the cache lost.
5. **The hosted runtime, control plane, MCP and Sandbox host**, as before, on
   the cache store. The control plane is read-only: the routes that wrote
   configuration (`PUT /v1|v2/accounts/self/policy`, `PUT …/providers`,
   `POST …/signals`, `…/observations`, `…/rate-observations`, the inbox
   quarantine and retry, and every `/v1/accounts/self/repositories/…` route)
   answer **410**: the body's `error` says configuration is read-only on this
   relay and is written with `hobo ci` through the config service, and its
   `configService` names the binding's kind. Read routes are unchanged. MCP's change feed is the store's
   change ring. GitHub onboarding (the OAuth session flow, App installation
   and the owner's invitation) runs on the cache since phase 5
   ([Helpers on the cache](#helpers-on-the-cache)).

**Queue topics** ([`src/relay-queue.ts`](src/relay-queue.ts); records
`HostedQueueDelivery` and `HostedLeaseStep` in
[`data-models/queue.proto`](data-models/queue.proto), constrained by
[`queue.cue`](data-models/queue.cue)):

| Topic | Consumer | Message | Idempotency key |
|---|---|---|---|
| `hobo-ci-intake` | `api/intake.ts` | a verified delivery (body base64, retained up to 7 days) | the GitHub delivery id |
| `hobo-ci-lease-steps` | `api/lease-steps.ts` | one lease step, delayed until due | `${leaseId}:${step}:${n}` |
| `hobo-ci` | `api/queue.ts` | the repair tick (schedule `hobo-ci-repair`, every 15 minutes) | none |

- **Intake.** `POST /github/webhooks` checks the signature, records the
  delivery's dedupe markers in the cache (3 commands), sends the delivery to
  `hobo-ci-intake` and only then answers 202. If the send fails the markers are
  undone and GitHub gets a 503. The consumer processes the delivery
  (`runtime.processDelivery`: GitHub REST re-reads, queue, reserve, launch). A
  body that is not JSON is acknowledged and logged as
  `hobo_ci_webhook_quarantined`; any other failure is thrown, so the queue
  redelivers it.
- **Lease steps** replace the scan over every in-flight lease. When a lease
  enters a chain (`reserved`/`dispatching`: `dispatch-check`;
  `dispatched`/`claiming`: `claim-timeout`; `running`/`uncertain`:
  `reconcile`), the store's hook sends that chain's next rung. Rung `n` is due at
  the lease's `createdAt` plus 1, 2.5, 5, 10, 20, 30, 45, 60, 90, 120, 180, 240,
  360, 480, 720, 1080, 1440 minutes, so two chains of one lease and step use the
  same keys and the queue keeps one. A step reads its lease; if the lease left
  the chain it stops; otherwise it sends the next rung, then recovers a stale
  intent (2 minutes, 17 for a Sandbox operation) or reconciles the lease with
  its host (a `reserved` lease at its dispatch check admits pending work
  instead). A step whose lease the cache lost rebuilds it by name from the job
  the message carries. Past the last rung, the repair tick covers it.
- **Repair tick** (backstop): the cache fleet's tick (usage, register upkeep,
  the budget decision; [below](#the-cache-fleet)), then `rebuildInflight`,
  then the repair scanners on the cache (GitHub deliveries that failed are
  redelivered; queued jobs whose delivery never came are admitted; phase 5),
  then the runtime's full tick over every in-flight lease. A sealed cache move
  schedules a delayed repair message (idempotency key
  `cache-fleet-activate-<epoch>`) for when its seal is over.
- **The handoff.** In production each consumer hands its message to the current
  production deployment's `POST /internal/queue-wakeup` (authenticated with
  `CRON_SECRET`, from the config service), as since PR #1881: a repair tick that
  fails there is acknowledged and dropped, a delivery or lease step is answered
  503 and held for redelivery. A pre-4b inbox wakeup (`{deliveryId}`) is
  acknowledged and ignored: this relay has no inbox. Off production the message
  runs in the consumer itself.

**Probes.** `/healthz` answers 200 always, before the relay is composed, with
`{ok: true, commit}`: the commit Vercel built the deployment from
(`VERCEL_GIT_COMMIT_SHA`), or null off a Git deployment.
`/readyz` answers 200 or 503 with `{ready, configService, configStale, cache,
executionHost, workers}`: the config service loads, the cache answers a read
(one command), an execution host (the Sandbox controller) is configured, and
the repair evidence in the cache is not `failing`; a stale config copy is
reported but still ready, and `workers: "starting"` (no evidence yet: a new
deployment, or a lost cache) is ready too. While the relay cannot start (the
config service unreachable on a cold start, an invalid configuration or cache
binding) `/readyz` answers 503 `{ready: false, started: false, state}` and
every other route 503. `state` names why, never a value: `not-configured` (the
store holds no valid relay configuration, or none is bound), `config-service-denied`
(the store refused the relay's OIDC identity), `config-service-unavailable`,
or `start-failed` (the log's `hobo_ci_relay_init_failed` says more).

**What the deployment needs.**

| Name | Where | What |
|---|---|---|
| `HOBO_CI_CONFIG_SERVICE` | project env | `infisical` in production |
| `INFISICAL_SITE_URL`, `INFISICAL_IDENTITY_ID`, `INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`, `INFISICAL_SECRET_PATH` | project env (the config-service binding) | [Config service](CONFIG-SERVICE.md) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN`; `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`; `BLOB_STORE_ID` | injected by each cache's Marketplace integration or store connection | cache-fleet members (or `VALKEY_URL` / `REDIS_URL` for Aiven or a self-hosted Valkey) |
| `VALKEY_URL`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BLOB_STORE_ID` | the config service, optional | members the environment does not bind (an Aiven Valkey URL is stored here) |
| `HOBO_CI_CACHE_OFFERS_JSON` | the config service or project env, optional | the declared offers, budget caps and switch marks ([below](#the-cache-fleet)) |
| `HOBO_CI_CACHE_MONTHLY_COMMANDS` | project env, optional | Upstash's allowance in the default offers |
| `HOBO_CI_EVENTS_URL`, `HOBO_CI_EVENTS_TENANT` | project env, optional | relay failures as CloudEvents |
| Every `RelayRuntimeConfig` key | the config service | [Config service](CONFIG-SERVICE.md#what-the-folder-holds); `HOBO_CI_SANDBOX_PROXY_TOKEN_KEY` (32 random bytes, base64url) is required with `HOBO_CI_SANDBOX_ENABLED` |

No `DATABASE_URL*` or Neon variable is read.

**Cache commands per job.** `test/stateless-relay.test.ts` pins them for one
Sandbox job through the whole composition (in-memory engine, scripts cached):
3 per webhook delivery (three deliveries), 57 for the intake that queues,
reserves and launches it (a launch is ten lease transitions, each a
compare-and-set plus the routing check a held state takes, four ring appends
and the egress and proxy bindings), 6 and 2 for the in-progress and completed
deliveries, 4 for the first three step rungs, 20 for the step that stops both
VMs and settles, and 1 for the step that ends the chain: **99**, plus one
command for the usage counter in each relay-clock minute the relay did work
(four in the test's hour, so it pinned **103** in phase 4b). Phase 5 pins
**104**: settling reads the proxy VM's own meter into the cache before the VM
is stopped (3 commands), and the warm-up repair tick, which now runs the
scanners, moves one usage-counter flush out of the measured phases. The store's own
per-step cost on a workflow-bridge path is in
[`@hobo/ci-gh-actions`](../ci-gh-actions/README.md#command-cost) (62 before
phase 4b, 43 after).

**Tests.** `test/stateless-relay.test.ts` composes the relay over the in-memory
cache, an `env` config source, an in-memory queue with the platform's
idempotency and delays, a GitHub stand-in and Sandbox drivers that keep VMs in
a map: a job from webhook to settlement; duplicate deliveries (the same id
twice, the intake message delivered twice, GitHub's redelivery under a new id)
giving one lease, one Sandbox and one runner; the cache wiped mid-job and the
lease rebuilt by name, the running job adopted rather than stopped and nothing
provisioned twice; every configuration write refused with 410; and `/readyz`
and `/healthz`; and, since phase 5, a lease rebuilt after a cache loss
settling from its proxy VM's meter (and staying unsettled when neither the
cache nor the VM has one), the delivery and queued-job scanners on the cache,
worker health reported as starting, ok and failing, and the owner's
invitation redeemed once. `test/relay-offers.test.ts` lowers every manifest in
`offers/` and checks the defaults against the catalog. `test/cache-backend.test.ts`, `test/cache-fleet.test.ts` and
`test/relay-queue.test.ts` cover the cache bindings and offers, the cache
fleet (one member; several, bootstrapped and cached; failing closed; a
planned move sealed, refused everywhere once cached answers lapse, then
activated; no move back within the month; a failover after probing; usage
per member), the messages, the step ladder and the handoff. The handoff's bodies and answers are a PACT
([`contracts/queue-handoff.pact.json`](contracts/queue-handoff.pact.json)),
executed by `contracts/queue-handoff.consumer.test.ts` against both sides.
Nothing here has run against Vercel, Upstash, Infisical or GitHub.

### The cache fleet

ADR-0179 phase 4c ([Options routed by budget](../../docs/design/hosted-relay-stateless.md#options-routed-by-budget)).
`createCacheFleet` ([`src/cache-fleet.ts`](src/cache-fleet.ts)) puts every
bound cache behind one `EphemeralStatePort`.

- **One active member, from the register.** The fleet's assignment log is kept
  on every member in `hobo-ci:<env>:fleet:assignment`
  (`ephemeralAssignmentReplica` in [`@hobo/backend-fleet`](../backend-fleet/README.md))
  and the active member is the majority-decided current entry. An instance
  caches the answer for a minute, counted from when its read started. With a
  single member there is no register and nothing is read. An empty register
  is bootstrapped with the first configured member, the same bytes from every
  instance.
- **Failing closed.** With no majority, an epoch completion cannot settle, or
  a sealed fleet, every cache call fails with `CacheFleetUnavailableError`
  (`retryable`): a queue message is redelivered, a webhook is answered 503
  (as when the cache is down), `/readyz` reports `cache: false`. The relay
  never guesses a backend. With two members, losing either leaves no
  majority: a failover needs three or more.
- **A move seals first.** A tick that decides to move writes a sealed entry
  (nobody may write), sends the delayed activation tick, and returns. After
  2.5 minutes (`DEFAULT_SEAL_WAIT_MS`, more than twice the minute an instance
  caches its answer, so every cached answer has lapsed and every call made
  under it has ended) a tick writes the target as active. No two instances
  write to different members. A planned switch seals with the old member
  still named (it takes the entry first); a failover seals with none. A target
  that goes away while sealed is replaced by the failover choice. The new
  member starts cold and the relay rebuilds leases by name, as after any
  cache loss.
- **Budget routing on the repair tick.** Usage is flushed; the register is
  completed, repaired, rejoined and its TTL refreshed on every member; each
  member's spend this month is read from its own counters
  (`hobo-ci:<env>:fleet:usage:<member>:<unit>:<YYYY-MM>`); the month's
  workload is converted into every member's units with the bindings' cost
  tables (`EPHEMERAL_STATE_COMMAND_COST`, `LIBSQL_EPHEMERAL_COST`,
  `VERCEL_BLOB_EPHEMERAL_COST`) by the mix of port calls this instance
  routed; and `routeFleetByBudget` decides: free, then prepaid, then the
  cheapest pay-as-you-go; leave the active member at **90%** projected of an
  allowance it would stop at, take another only below **80%**, so a member
  left for its allowance is not taken back until the next month; a move for
  preference alone only to a cheaper tier or month, after an hour on the
  current one; a failover when the active member has failed for 10 seconds
  (the tick probes it three times, five seconds apart). Each decision is one
  `hobo_ci_cache_fleet_decision` line: action, epoch, active, target,
  reasons, eligible members and each member's projected percentage and cost.
- **Offers.** Defaults ([`src/cache-offers.ts`](src/cache-offers.ts)) are the
  vendor free tiers recorded in the ADR on 2026-11-11: Upstash 500,000
  commands a month then blocked; Valkey (Aiven free or self-hosted) no
  command cap; Turso 500 million rows read and 10 million written then
  blocked; Blob pay-as-you-go at $0.40 a million simple and $5 a million
  advanced operations (Pro rates via `@hobo/provider-vercel-blob`, not
  verified for this store) with a cap of zero; `REDIS_URL` no model, so it is
  only ever a failover target. `HOBO_CI_CACHE_OFFERS_JSON` (`RelayCacheOffers`,
  [`data-models/cache_offers.proto`](data-models/cache_offers.proto),
  constrained by `data-models/cache-offers/cache_offers.cue`) replaces an
  offer per member and sets the caps and marks; an invalid document fails
  start-up naming the key.

What it costs: with two or more members, each busy instance reads the
register once a minute on every member (about 43,000 reads a month per
instance per member), and each repair tick about four commands per member.

**Not yet.** That a Vercel Sandbox lookup by an unknown name answers 404 is
assumed from the SDK's error shape, not observed. Provider usage pulls for
budgets (Vercel's usage API for Sandbox, GitHub's billing usage API) need
clients the repository does not have; exposure stays configured spend plus
in-flight holds, and each cache member is metered at its own client.

### Helpers on the cache

ADR-0179 phase 5. What the removed PostgreSQL composition kept in its own
tables lives in the cache fleet's active member, each record with a TTL; the key
table is in [`@hobo/ci-gh-actions`](../ci-gh-actions/README.md#keys-values-and-ttls).

- **Repair scanners.** `createWebhookRepair` and `createQueuedJobRepair`, as
  before, over `CacheWebhookRepairClaims` and `CacheQueuedJobRepairClaims`:
  one lock per scanner and App, cursors in the cache, the 20-a-minute
  redelivery window and the 10-a-minute REST budget as minute counters. A
  delivery the relay already took in (its 24-hour delivery marker) is not
  redelivered. Each repair tick runs both once and the queued scan up to nine
  more steps (its REST budget's worth), then resumes from its cursors on the
  next tick: no continuation messages. A queued job the scan finds is
  admitted under its deterministic lease id, so one already admitted, or
  rebuilt by name after a cache loss, is a no-op.
- **Worker health** (`src/worker-health-cache.ts`, record
  `RelayWorkerHealth` in [`data-models/worker_health.proto`](data-models/worker_health.proto)):
  the last success and failure of the repair tick and each scanner, per
  deployment, 24 hours. Missing is `starting`; a failure newer than the last
  success, or no success for 45 minutes, is `failing`, and `/readyz` answers
  503.
- **Fleet verdicts** (`src/fleet-verdict-cache.ts`, record `FleetVerdict` from
  `@hobo/ci-gh-actions`): what a relay with a view of the fleet last reported
  for a repository, one key each, kept until the verdict expires (at most 300
  seconds). The hosted relay only keeps and serves them, at
  `/v1/fleet/verdicts/{owner}/{repo}`
  ([ADR-0180](../../docs/design/adr/fleet-verdict.md#adr-0180)). Missing reads
  as "nothing blocked", which is what runner routing assumes without one.
- **Sessions, OAuth `state`, App installation**: `createStatelessAppOnboarding`
  from `@hobo/ci-gh-actions`. Records are named by an HMAC under a key derived
  from `HOBO_CI_SESSION_KEY` and, where they hold a credential, sealed with
  AES-256-GCM under another; the browser carries only an opaque cookie. A
  verified installation is usable for a day and logged as
  `hobo_ci_installation_verified` (ids only) for `hobo ci` to write into the
  config service. Registering an App answers 410.
- **Owner bootstrap.** `POST /v1/app-bootstrap/start` with
  `Authorization: Bearer <invitation>` redeems the invitation the config
  service holds (`HOBO_CI_BOOTSTRAP_TOKEN_SHA256`, expiring at
  `HOBO_CI_INVITATION_EXPIRES_AT`) once (a consumed marker in the cache until
  it expires) and sets a ten-minute `__Host-hobo_ci_bootstrap` cookie that
  stands for `HOBO_CI_ONBOARDING_CONTROL_TOKEN` on the same-origin owner
  routes and the OAuth start. Every other `/v1/app-bootstrap/` route answers
  410: `hobo ci` creates the App. `hobo ci` rotates the invitation after use.
- **Sandbox meters.** The proxy VM counts what it reserved and the quota calls
  it made, and answers `GET /internal/meter` to the lease's derived token.
  The Sandbox host reads it before stopping the VM and keeps it in the cache
  (`sbx:proxy-meter:<leaseId>`); settlement charges the larger of it and the
  relay's own counters, and uses it alone after a cache loss, so a rebuilt
  Sandbox lease settles (its runner, GitHub's `runner_id`, is deleted first).
  A VM that no longer answers leaves the relay's counters; with neither, the
  lease stays `uncertain` until its record lapses.

### Offers as provider manifests

Each cache-fleet backend and lifecycle driver is a provider manifest in
[`offers/`](offers/) (`hobo.provider-manifest/v1`, ADR-0178): Upstash Redis
(free and pay-as-you-go), Aiven for Valkey free, Turso free, self-hosted
Valkey, Vercel Blob (prices **unverified**), Vercel Queues (price
**unverified**: an external charge model, so the catalog reports it unrated,
never free) and Vercel Workflows on the managed World. Cache offers declare
`kv.ephemeral-state/v1` (`KV_EPHEMERAL_STATE_PROFILE` in
`@hobo/kv-redis-compatible`), drivers `lifecycle.lease-driver/v1`
(`LIFECYCLE_LEASE_DRIVER_PROFILE`, `src/lifecycle-driver.ts`).
`scripts/generate-offers.mts` lowers them with `@hobo/provider-manifest` into
`@hobo/pricing` catalogs and writes `src/_generated-assets/relay-offers.ts`
(`pnpm test` fails when it is stale): the catalogs, each cache backend's
default offer derived from its rate card, and the drivers' offers. What a
catalog cannot say is in the generator's binding table, with its reason: that
a free plan is blocked, not billed, when spent, and when a driver may be
chosen. `defaultCacheOffers` reads those defaults;
`HOBO_CI_CACHE_OFFERS_JSON` still overrides them, and
`HOBO_CI_CACHE_MONTHLY_COMMANDS` Upstash's allowance. At start-up one
`hobo_ci_offer_selection` line logs the policy decision: the driver chosen
(Vercel Queues), why each other driver was not (Workflows: not built, and not
pinnable before 2026-11-18), and each cache backend's rate card. The
catalogs are registered by the phase 6 deploy (`hobo registry add`), not by
the relay.

## Hosted relay

The relay's HTTP surface is not this package's: `createRelayHandler` (Fetch),
`createNodeRelayHandler` (Node adapter) and the failure log live in
[`@hobo/ci-gh-actions`](../ci-gh-actions/README.md#one-http-layer) and are the
same code `hobo ci serve` and the container image run. This package is the
Vercel host around it: the function entrypoint, which paths stream
(`src/relay-streams.ts`), the queue consumers, the schedule, the cache store
wiring and the Sandbox runner.

It runs the same relay core as the Node service ([one relay, thin
hosts](../ci-gh-actions/README.md#one-relay-thin-hosts)); what is specific to
this host is the relay cache store, the queue topics and 15-minute schedule
that drive intake, lease steps and repair, the Sandbox runner backend, OAuth
onboarding, and the webhook and queued-job repair.

The relay's [MCP server](../ci-gh-actions/README.md#mcp-server) is mounted at
`/mcp` with `sessions: "none"`: a function instance does not outlive its
request, so each request stands alone and is answered with JSON, `/mcp` is not
a streaming path, and resource subscriptions are not advertised. Tools and
resources work as on the Node service, and `wait_for_events` is the change
feed. A wait holds the function for its duration, so its ceiling comes from
the function's own limit: `vercel.json` gives `api/relay.ts` a `maxDuration`
of 300 seconds (the limit the queue consumer's two-minute wait for a worker
pass already assumes), `src/function-limits.ts` holds the same number, and
`mcpWaitCeilingMs` keeps 30 seconds of it back and never exceeds 50, the most
an MCP client waits by default. `test/function-limits.test.ts` fails if the
two numbers differ. The server reads through the store's `observer()`, and
`wait_for_events` reads the store's change ring.

Queue messages and configuration follow **parse, don't validate**:
`parseRelayQueueMessage` parses a queue payload into the derived types
`RelayQueuedDelivery` and `RelayQueuedStep` (records `HostedQueueDelivery` and
`HostedLeaseStep` in [data-models](data-models/), constrained in CUE), and the
config service's entries are parsed once into `RelayRuntimeConfig`; nothing
downstream re-checks a raw value, and provider-supplied metadata does not
become routing authority.

The GitHub App, the Vercel schedule and the queue topics are actors that
submit commands to the relay: a signed delivery, a lease step, a repair tick.
The relay keeps no event-store of its own: GitHub is the system of record for
every job, and the relay's lifecycle events go out as structured logs and
CloudEvents (`HOBO_CI_EVENTS_URL`). What the cache holds are projections, the
materialized views the relay acts on: one lease record per job attempt, the
per-account in-flight index and the job-taken markers, each rebuilt from
GitHub and Vercel by deterministic name when lost. There is no snapshot to
restore; a lost cache is rebuilt. The read store for MCP and the account API
is the same cache, with the per-account change ring as its feed.

A Vercel Schedule named `hobo-ci-repair`, declared in `vercel.json`, publishes a
repair message to the private `hobo-ci` queue every 15 minutes. The target is
the queue topic, not a URL, so no shared secret is involved and nothing public
can trigger it; the consumer accepts only that schedule name. Fifteen minutes is
the shortest interval Vercel's Hobby plan allows, and that plan adds up to 15
minutes of jitter. Every deployment declares the schedule, so a deployment
outside production acknowledges the scheduler's run without working it. Normal
work uses an immediate queue wakeup, and the queue schedules a delayed
continuation for larger delivery histories. `GET /internal/tick` remains for an
operator's own scheduler.

Production queue messages stay pinned to their publishing deployment. Each
new callback forwards a validated wakeup to the canonical relay and acknowledges
it only after the current worker succeeds. Keep the canonical URL and the
`CRON_SECRET` in the config service stable while those messages can be retried. The
handoff does not change callbacks from deployments predating this mechanism;
retire or drain those separately. Messages expire after one hour; GitHub,
re-read by the repair tick, remains the source of truth for recovery.

The handoff is one request, never retried inside the function. Any answer but
`204` fails with `queue handoff failed: status <code>`, plus
`, retry-after <n>s` when the relay stated one: two numbers, never the response
body, a header's text or the secret. What happens next is the queue's job, set
by the consumer's `retry` policy (`@vercel/queue`'s `handleNodeCallback`
option; `redeliverRefusedWakeup` in `src/queue-forwarding.ts`):

| The callback failed with | The queue is told | Next delivery |
| --- | --- | --- |
| `503` from the relay, or the store back-off in-process | `{ afterSeconds }`: the message's lease is moved out and the callback answers `200` | After the larger of the relay's `Retry-After` and 5 s doubling per delivery of that message (5, 10, 20, 40, 80, 160), never more than 300 s |
| Any other status, a network failure, a timeout, missing configuration | Nothing: the error propagates and the callback answers `500` | The queue's default interval |

Before this, every failure was thrown straight back, and while the relay's
store was down each wakeup came round again about every 15 seconds until it
expired. The doubling is there because the relay's generic 503 says
`Retry-After: 5`: honoured alone, that would be a five-second loop. A
rescheduled message leaves no error in the queue's own log, so the consumer
writes `hobo_ci_queue_handoff_deferred` for it (see the failure log below).
`test/queue-redelivery.test.ts` runs the installed queue client against a
stand-in for the queue service and checks the lease change it sends.

A repair tick (`{"source": ..., "name": "hobo-ci-repair"}`) that fails, for
any reason, is answered `204` and dropped, because the next tick does the same
work. The reason does not matter: the first attempt after a store back-off
fails with the store's own error, not `StoreUnavailable`. That matters for old
production deployments: each keeps its own queue consumer and schedule, still
forwards to the current relay, and retries a refusal at once with the code it
was built from. Acknowledging the tick is the one thing that stops those
retries from here. A webhook delivery wakeup is never dropped; it is held as
above.

Vercel's Hobby plan is limited to personal, non-commercial use. The cache,
queue operations and Functions can incur usage charges according to the chosen
plans. A temporary deployment or Vercel Drop alone is not a durable inbound App
endpoint.

## Hosting the relay on Vercel

The relay is Vercel Functions, private queue consumers and a schedule, all
declared in `vercel.json`; its state is the cache and its configuration the
config service ([The stateless relay](#the-stateless-relay)). Node 24 is
required.

`CRON_SECRET` is required and must be at least 32 bytes. The scheduler sends it
as `Authorization: Bearer <secret>` to `GET /internal/tick`; the endpoint only
queues repair. The queue handoff uses the same server-side credential for its
authenticated `POST /internal/queue-wakeup`; the credential never appears in
the payload. The GitHub App is created with `hobo ci` and its credentials
(`HOBO_CI_GITHUB_APP_ID`, `HOBO_CI_GITHUB_APP_PRIVATE_KEY`,
`HOBO_CI_WEBHOOK_SECRET`) are read from the config service, as are
`HOBO_CI_GITHUB_APP_CLIENT_ID`, `HOBO_CI_GITHUB_APP_CLIENT_SECRET` and
`HOBO_CI_SESSION_KEY`, which together enable browser installation. See
[Config service](CONFIG-SERVICE.md) and
[GitHub onboarding](../ci-gh-actions/ONBOARDING.md).

The reviewed sibling `ci-gh-actions` workflow and bootstrap files are embedded
into the build by `scripts/generate-assets.mts`; a contract test verifies their
contents match the sources. Both asset generators format their output with the
repo-pinned Biome before writing, and the proxy bundle's `--check` mode compares
against those formatted bytes. A deployment must verify rewrites, the private queue
trigger and scheduler before production use. Contract tests run without live
GitHub or Vercel credentials. The real-process proxy shutdown test uses a
35-second Vitest deadline so cold TypeScript startup on slower filesystems is
not mistaken for a shutdown failure; its child-process timeout stays bounded
at 30 seconds.

The isolated Sandbox runner integration is configured via
`HOBO_CI_SANDBOX_ENABLED=1`, `HOBO_CI_SANDBOX_TEAM_ID`,
`HOBO_CI_SANDBOX_PROJECT_ID`, `HOBO_CI_SANDBOX_ISSUER` (the pinned Vercel
team issuer), and `HOBO_CI_SANDBOX_DOMAINS_JSON`
(an explicit hostname allowlist). GitHub runner setup, checkout, Node setup,
and artifact transfer can require `github.com`, `api.github.com`,
`codeload.github.com`, `raw.githubusercontent.com`, `nodejs.org`,
`release-assets.githubusercontent.com`, `*.actions.githubusercontent.com`,
and `*.blob.core.windows.net`. Add the hosts used by each workflow's own
dependencies and redirect targets; this list does not cover every workflow.
The only permitted wildcard patterns are
`*.actions.githubusercontent.com` and `*.blob.core.windows.net`, which GitHub
documents for runner traffic. The Azure Blob suffix includes third-party storage
accounts; enabling it permits job traffic to those accounts as well.
`HOBO_CI_SANDBOX_PLAN` defaults to `hobby`. It requires a
matching two-VM Sandbox offer with current pricing and allocation evidence. The
proxy also accepts Vercel's global issuer and the exact team-ID issuer when the
signed token matches the expected audience, team, project, and bound Sandbox.
It does not accept another team's issuer path.
The implementation creates a temporary proxy VM before the runner VM and stops both
after the job. It downloads and verifies the runner archive before uploading it to
the runner VM. Both VMs, their network usage, and quota-control calls are
included in the reservation and settlement estimate.

On October 27, 2026, [the full GitHub acceptance workflow](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/40569580252/attempts/2)
passed on a Vercel Sandbox runner: setup, checkout, Node setup, runner identity and
checked-out revision verification, artifact upload and post-job steps succeeded.
The matching relay lease recorded the job, stopped both Sandboxes, deleted the
runner and settled the measured usage. This verifies the Vercel path for that
workflow and configuration; it does not verify external runner vendors or every
workflow's dependencies. On October 29, 2026, the built product CLI repeated that
acceptance through `hobo ci rerun --wait` in
[attempt 4](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/40569580252/attempts/4).
GitHub job `123727970151` matched lease `b1c3b545-ee2b-4bfd-be2c-1a47cb4d1257`;
both sandbox stages stopped, runner deletion was confirmed and 259,321
microdollars settled against a 637,800 microdollar reservation. Before admission,
the supported rate reattestation operation refreshed expired zero-credit pricing
evidence after checking the published rates; budgets and usage accounting stayed
unchanged. Live Sandbox tests on a Pro team also verified 16 MiB
transfers through an exposed port and matched forwarding identity claims to the
guest session; see [Sandbox egress](SANDBOX-EGRESS.md). The gateway's maximum
transfer size remains unverified.
The Vercel runtime admits isolated jobs only when Sandbox is explicitly configured;
without it, readiness remains false and isolated jobs are not launched. Recovery
first fences in-flight launch states and retains ambiguous create
or registration outcomes until their identities can be recovered. It also denies
the nonisolated workflow bridge because repository visibility
could change after a shared-label runner is registered. The readiness endpoint
also requires recent worker health. The
direct Function proxy is disabled in this production composition; the separate
proxy VM handles Sandbox traffic.

The proxy byte quota is not a hard limit on the provider bill. Traffic to the
public proxy port can be billed before authentication, and network overhead,
provider metering and Function usage can differ from the estimate. CPU usage
is charged conservatively because the provider has not documented the
aggregation of its CPU metric.

Once both Sandboxes have stopped, their measured usage is available, and runner
deletion is confirmed, the relay settles the cost even if assignment is unknown;
later GitHub observations can attach the job without declaring the runner idle.
After an ambiguous GitHub JIT registration, the relay looks for the unique runner by its
deterministic name and deletes it before settling. An absent or ambiguous
lookup holds the reservation because the original request could still finish;
there is no automated operator resolution for that case yet. A VM whose create response was lost is
looked up by deterministic name and stopped; the reservation stays held until
its identity, termination and usage are proven.

The managed relay embeds the reviewed Actions host workflow and standalone
bootstrap from `@hobo/ci-gh-actions`. Its build regenerates
`src/_generated-assets/relay-assets.ts`; commit that snapshot whenever the shared host
source changes. `test/relay-assets.test.ts` checks byte equality with the source.
The sandbox proxy bundle also lives in `src/_generated-assets/`: this directory
keeps non-protobuf generators out of the protobuf-owned `src/_generated/` tree.
The local persistent listener can wait without an age-based deadline; the
embedded hosted bridge still supplies and enforces its lease timeout.

### Liveness and readiness

`/healthz` answers 200 from the process alone; `/readyz` reports the config
service, the cache, the execution host and the repair evidence (see the probes
in [The stateless relay](#the-stateless-relay)).

With `HOBO_CI_EVENTS_URL` set, each failure below is also delivered as a CloudEvent (see the
[runner queue runbook](../ci/RUNNER-QUEUE.md)).

### Failure log

Every path that refuses a request with a fixed 503 body also writes one JSON line to stderr, so the
platform's runtime logs show why. The log is the relay's (`@hobo/ci-gh-actions` `src/failure-log.ts`),
so every host of the relay writes the same lines; `hobo_ci_relay_init_failed` is this host's own. Before this the relay failed silently: a relay that could not
start looked like a relay nobody was calling.

| Event | When | Fields |
|---|---|---|
| `hobo_ci_relay_init_failed` | Startup failed (the config service, the configuration or the cache binding); every request but `/healthz` answers 503 until it succeeds | `stage`: `stateless` |
| `hobo_ci_relay_request_failed` | A request threw after startup | `method`, `route`, `headersSent` |
| `hobo_ci_webhook_ingest_failed` | A signed delivery could not be committed (GitHub redelivers) | `event` |
| `hobo_ci_control_failed` | An account or registration API call threw | `method`, `route` |
| `hobo_ci_ready_check_failed` | The readiness check itself threw | none |
| `hobo_ci_queue_handoff_deferred` | The queue consumer could not hand a wakeup over (relay `503`, or store back-off) and asked the queue to redeliver it later | `status` (0 when the back-off was raised in-process), `afterSeconds`, `deliveryCount` |

Each line carries the error's class, its message and its cause's message, with URL credentials and
anything shaped like a token removed and the text capped at 300 characters. A route has its
identifiers replaced. One line per event name is written every 10 seconds per instance; `suppressed`
counts the ones held back since the last line. No request body, header or credential is logged, and
a failing logger never changes the response. When the
error or its cause is a database refusal, the line also carries its five-character SQLSTATE as
`sqlstate` (for example `28P01` for a rejected password).
