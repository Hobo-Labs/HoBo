# HoBo CI GitHub Actions

For end-user setup, use [`hobo ci connect`](../hobo/CI.md). It calls the isolated
onboarding API; the older workflow-bridge ceremony below remains available to
SDK callers on relays that support it. The package is publishable with its MIT
license because the product CLI consumes the exported account client; server
startup remains an explicit operation.
The exported browser/Node account client bounds response bodies to 2 MiB and
rejects invalid UTF-8 before protobuf decoding. Its executable consumer contract
covers these limits and disposal of error/redirect response streams. Product CLI setup is also checked through the production
HTTPS control plane and native PostgreSQL store in
[`packages/hobo/e2e/ci.test.ts`](../hobo/e2e/ci.test.ts).

`@hobo/ci-gh-actions` provides the hosted HoBo CI relay, account API, repository
installer and ephemeral GitHub Actions runner host. Once the repository's setup
PR is merged and its connection activated, workflows select HoBo with one line:

```yaml
runs-on: hobo
```

HoBo reserves the account's budget before dispatching a provider host. That host
claims a single-use JIT configuration with GitHub OIDC and starts the official
Actions runner. GitHub assigns an original queued job to that runner. The
original workflow, checkout, job token, logs and artifacts stay in GitHub Actions.

## Test this branch

Run from the monorepo root with Node 24, Linux x64, bash and git:

```sh
pnpm exec turbo run build --filter=@hobo/ci-gh-actions --concurrency=100%
pnpm --filter @hobo/ci-gh-actions act:install --directory /tmp/hobo-ci-tools
pnpm --filter @hobo/ci-gh-actions test:acceptance --act /tmp/hobo-ci-tools/act --evidence /tmp/hobo-ci-acceptance
pnpm --filter @hobo/ci-gh-actions test:acceptance --local --act /tmp/hobo-ci-tools/act --evidence /tmp/hobo-ci-local-acceptance
```

This is a connected test of signed HTTP intake, durable reservations, dispatch,
RS256 OIDC/JWKS, JIT authorization, the shipped host process launcher, actual act
workflow execution, signed completion, runner cleanup and settlement. Seven
original jobs consume five providers' free allocations, select the cheapest paid
provider and exercise provider-budget fallback. The exhausted account launches
no eighth job. Reopening and replaying the database preserves billing and results.
Missing JIT authorization, provider mismatch and skipped execution fail the test.
See [acceptance evidence](acceptance/README.md).

The local GitHub/provider boundary is simulated; the host commands really execute.
A local pass does not establish that GitHub assigned a real job or that a vendor
provisioned a machine. This branch also contains the manual GitHub workflow
[HoBo CI acceptance](../../.github/workflows/hobo-ci-acceptance.yml), with literal
`runs-on: hobo`, a bounded runtime, pinned actions and read-only repository access.
It requires an installed, connected relay and actual runner credentials. GitHub
must first discover its definition on the default branch; it can then be dispatched
for a selected branch. Its artifact records the actual self-hosted runner name,
repository, ref and checked-out SHA. Match its `hobo-<lease UUID>` runner to the
account lease API's actual job attribution to inspect routing and settlement.

## Follow HoBo platform budgets

For an owned development machine, see [local CI and the default dev container](LOCAL-DEVELOPMENT.md).
The `local` provider dispatches the existing bridge to `hobo-local-host`; original
jobs retain `runs-on: hobo`, lease accounting and JIT authorization. Offline act
also runs the local zero-budget scenario without GitHub credentials.

Stations exports `createCiBudgetRoutingBridge` over the typed relay client.
Subscribe it to the existing Broker `budget.ThresholdCrossed` and
`budget.Recovered` facts for the account's tenant. A profile chooses the eligible
provider offers; CI prioritizes usable free allocation, then the lowest projected charge.
The highest active configured threshold wins. Recovery restores the lower or
normal profile, and an empty offer list pauses new admissions.

[The Station example](../stations/README.md#ci-budget-routing) shows the wiring.
Signal cycles and crossed state persist with account policy; delayed facts and
replay cannot undo a newer transition. CAS conflicts are retried by the journal
consumer, and `reconcile()` applies rule changes to existing signal state.
Already running jobs retain their reservation and finish on their chosen host.

## Deploy the relay

For **`hobo ci serve`** in a checkout (bind/public origin split, ingress HMAC,
trust proxy) see [`REMOTE-RELAY-SERVE.md`](REMOTE-RELAY-SERVE.md). For the
container image and Compose/Kubernetes manifests see [`deploy/README.md`](deploy/README.md).

[Compose, Kubernetes, image build, TLS, backup and recovery](deploy/README.md)
are included. The runtime uses Node 24, UID/GID 1000, a read-only root filesystem,
a writable temporary directory and one persistent SQLite directory. A kernel
`flock` fences each partition's owner; process death releases the lock without
unsafe stale-PID removal. Kubernetes uses one replica and `Recreate`.

The tested container lifecycle includes authenticated policy changes, restart
persistence, duplicate-owner refusal, online backup, graceful SIGTERM and offline
restore from a read-only backup. `/healthz` reports process liveness; `/readyz`
reports recovered local partition readiness and becomes unavailable during drain.
External provider execution is verified by the separate runner acceptance path.
A failed or hanging readiness probe cannot keep admissions open indefinitely.
Process-spawning restore tests use a 15-second Vitest deadline for slow local
filesystems and parallel package runs; database and child-process locks retain
their own shorter timeouts.

Configure these bindings; secret values stay in the hosting platform's secret
files or secret manager:

| Binding | Purpose |
| --- | --- |
| `HOBO_CI_PUBLIC_URL` | Public HTTPS origin; TLS terminates at the reverse proxy |
| `HOBO_CI_DB` | Persistent database path, including its adjacent lock file |
| `HOBO_CI_GITHUB_APP_ID` | Shared HoBo GitHub App ID |
| `HOBO_CI_GITHUB_APP_KEY_FILE` | RSA App private key file |
| `HOBO_CI_WEBHOOK_SECRET_FILE` | GitHub webhook secret file; legacy secret env binding also supported |
| `HOBO_CI_CONTROL_TOKENS_FILE` | Account/installation authority and bearer-token hashes |
| `HOBO_CI_CONFIG` | Optional initial policy seed; persisted configuration wins after first start |
| `HOBO_CI_HOST`, `HOBO_CI_PORT` | Listen address; defaults to `127.0.0.1:8787` |

The control-token file uses generated `@hobo/ci` protobuf JSON:

```json
{
  "tokens": [{
    "accountId": "your-hobo-account",
    "installationIds": [12345],
    "tokenSha256": "replace-with-64-lowercase-hex-digest-of-your-client-token",
    "scopes": ["policy:read", "policy:write", "repositories:write", "operations:write"]
  }]
}
```

Generate random client tokens of at least 32 characters. Hash the exact bearer
value, without a trailing newline. Tokens are never stored in the journal or
returned by the API. Installations are bound to one HoBo account by the trusted
platform provisioning process; request JSON cannot grant itself another account's
installation. Multiple keys for the same account support scoped clients and
rotation. Keep the file private and restart the service after credential rotation.
A platform host can inject its own `ControlAuthenticator` instead of the file
adapter. App keys and installation tokens remain in the relay.

The GitHub App needs Actions, Administration, Contents, Workflows and Pull requests
write access, plus Metadata read. Subscribe to `workflow_job` and `workflow_run`.
The hosted Vercel adapter supplies the App bootstrap and OAuth callbacks described
below. Self-hosted deployments must mount equivalent authenticated callbacks and
provide encrypted secret storage. Customer repository setup is handled by the
account APIs below.

[Hosted GitHub App bootstrap and account onboarding](ONBOARDING.md) describes the operator and account flows.

## Repository and organization environments

A repository can keep named relay endpoints and their desired budget policies
in `.hobo/ci.json`. Start with the [two-environment example](examples/project/ci.json),
then replace the example origins, accounts, provider bindings and budgets with
those provisioned for your environments. The local example uses
`http://127.0.0.1:8787`; an integration environment can point to a hosted relay,
such as `https://hobo-ci.vercel.app` when that is the relay for its account.
An optional `githubWebhookOrigin` records the separate public HTTPS origin
used for GitHub delivery, such as a tunnel to the local container. It is
configuration metadata: it neither registers the App nor proves the hostname is
publicly reachable. **Production GitHub App webhooks should target a shared ingress
front door** (`createWebhookIngressHandler`), which loads this file at the event
commit and forwards `workflow_job` events to the matching `relayOrigin`. Set
`jobAdmission: "pull"` (or use loopback defaults) for local environments so
developers poll GitHub instead of exposing a relay URL. Override the selected
environment with `HOBO_CI_ENVIRONMENT` or a gitignored `.hobo/ci.local.json`
overlay. Fork pull requests resolve config at the **base branch** ref and honor
`selection.forkPullRequestEnvironment` so untrusted head refs cannot aim webhooks
at an attacker-controlled relay.
Amounts are USD microdollars. Each policy still requires separately provisioned
providers and a repository connection on its selected relay.

The [project JSON Schema](schema/ci-project.schema.json) defines the configuration
format using JSON Schema draft 2020-12. The example's `$schema` annotation points
editors to that schema, and the package exports it as
`@hobo/ci-gh-actions/schema/ci-project.schema.json`. The parser uses its shipped
schemas and never fetches the `$schema` URL while loading configuration.

Put reusable values in the document's typed `definitions` registries. For
example, define the Linux pool and routing strategy once, then use these policy
fields in every environment that shares them:

```json
{
  "pool": { "$ref": "#/definitions/pools/linux" },
  "routing": { "$ref": "#/definitions/routing/freeThenCheapest" }
}
```

The registries cover `pools`, `routing`, `budgets`, `providers`, and `secrets`.
Provider array entries can reference individual provider definitions; an
entire secret-requirement map can reference a named `secrets` definition.
References must point to an existing value in the correct registry within the
same document. They cannot include sibling overrides, chain to other references,
or load another file or URL. Both stored definitions and resolved environments
are validated. The schema's `$defs` define reusable **types**; the configuration's
`definitions` hold reusable **values**. The example uses one shared pool, routing
strategy and secret declaration set, and separate budgets for its different
local and integration spending limits. Secret values remain outside both.
Policy and secret-declaration digests are calculated from resolved values, so
changing a referenced definition changes every affected environment's digest.

Each environment may declare the names of its required secrets under `secrets`.
For example, `"HOBO_CI_ACCOUNT_TOKEN": { "requiredFor": ["deployment"] }`
declares a requirement without recording a value. Names are uppercase identifiers;
`requiredFor` contains one or both of `deployment` and `execution`. Do not put
credentials, secret-manager URLs, or commands in the project file. Provision and
rotate each environment's secrets through trusted operator-controlled bindings
outside the repository.
After building and inspecting a profile as shown below, the `check-secrets`
command provides an explicit preflight for a deployment or
execution phase. Point it at a trusted directory containing a file for each
declared name required in that phase; file contents are not printed. For example:

```sh
pnpm --filter @hobo/ci-gh-actions project check-secrets \
  --environment local --phase deployment --secret-dir /path/to/local-secrets \
  --trusted-origin http://127.0.0.1:8787 --trusted-account local-ci \
  --trusted-secrets-sha256 "$REVIEWED_SECRETS_SHA256" \
  --allow-secret HOBO_CI_ACCOUNT_TOKEN
```

Run the corresponding `execution` preflight before starting the relay.
Inspection prints the secret declaration digest; review and record that digest
independently of untrusted repository changes. Supply a separate `--allow-secret`
for every name the chosen phase is authorized to resolve. Trust the target,
digest, directory and allowlist from operator-controlled sources.
The example demonstrates two requirements; add every secret required by your
actual deployment and runtime. A declaration name identifies a secret for the
preflight and does not itself configure a server binding.
The SDK also exposes `resolveCiSecrets` with an operator-approved name allowlist
and a caller-supplied resolver. `createCiSecretDirectoryResolver` reads mounted
files, while `createCiEnvironmentSecretResolver` supports explicitly mapped
environment variables. Applications can supply another trusted resolver without
putting its configuration in the project file.
This check is explicit: declaring a secret does not create it, inject it into
the relay, or automatically gate a Vercel deployment. For containerized relays,
mount secret files separately as described in the [deployment guide](deploy/README.md).
Configure secret bindings from a trusted operator source, not from a pull request
or the repository file. An external proxy can protect a credential only when its
substitution rules cover the destination and request. The existing
[`@hobo/adapter-opensesame`](../adapters/adapter-opensesame/README.md) verifies
surrogate substitution for the Vercel API; it does not currently provide a
verified substitution binding for the HoBo relay account token or GitHub App
credentials.

Build the package, then inspect a profile without credentials or writes:

```sh
mkdir -p .hobo
cp packages/ci-gh-actions/examples/project/ci.json .hobo/ci.json
pnpm --filter @hobo/ci-gh-actions build
pnpm --filter @hobo/ci-gh-actions project inspect --environment local
pnpm --filter @hobo/ci-gh-actions project inspect --environment integration
```

Inspection prints the selected account, origin, budget and canonical policy
SHA-256. Review the selected policy in a trusted source and record its digest
outside the repository. Applying requires an explicit environment, a separately
trusted origin and account, the reviewed policy digest, and an account token:

```sh
pnpm --filter @hobo/ci-gh-actions project apply \
  --environment local \
  --trusted-origin http://127.0.0.1:8787 \
  --trusted-account local-ci \
  --trusted-policy-sha256 "$REVIEWED_POLICY_SHA256" \
  --token-file /path/to/local-account-token
```

Use a different trusted tuple and token for integration. The target and digest
are checked before obtaining credentials; the relay account and revision are
checked before writing. Do not automatically approve a digest calculated from
an untrusted pull request, or apply its configuration with privileged credentials.
The same operations are available from `@hobo/ci-gh-actions/project-config`:
`defineCiProjectConfig`, `parseCiProjectConfig`, `selectCiEnvironment`,
`ciEnvironmentPolicySha256`, `createConfiguredCiRelayClient`, and
`applyCiEnvironmentPolicy`.

An organization can supply its own config with `--organization-config PATH`.
Repository profiles replace entire same-named organization profiles; they are
not merged field by field. Each input document resolves its own typed references;
repository references cannot reach organization definitions. Existing `templates`
and `extends` inputs remain supported for compatibility; use typed definitions
and references for reusable configuration components.
The selected environment's trusted target and policy
digest must still come from a source independent of both files. Distinct
profiles require distinct `(origin, accountId)` pairs; separate origins can
still share storage, so provision separate relay stores and account credentials
when environments need separate billing.

These profiles select the control endpoint and policy; they do not change the
GitHub App webhook. For live jobs, register each environment's publicly
reachable HTTPS webhook and connect the repository to the intended relay. The
default `runs-on: hobo` label is shared: do not run multiple relays for the same
repository and label at once, since GitHub can assign a job to either runner.
Switch the active App/relay ownership before using another environment. Local
offline tests can use simulated GitHub delivery; see [local deployment](deploy/README.md).

## Connect a repository

Use `createCiRelayClient` from `@hobo/ci-gh-actions/client` or the root SDK. Its
HTTPS client sends generated protobuf JSON, parses generated responses, refuses
redirects and keeps bearer tokens out of errors. The control API uses the current
policy revision as an ETag; writes require `If-Match` and return `409` on conflict.

```ts
import { createCiRelayClient } from '@hobo/ci-gh-actions/client';

const ci = createCiRelayClient({
  origin: process.env.HOBO_CI_PUBLIC_URL!,
  accountToken: () => process.env.HOBO_CI_ACCOUNT_TOKEN!,
});
const setup = await ci.prepareRepository({
  repository: 'example/private-repository',
  trustedRepositoryAcknowledged: true,
  allowedRefs: ['refs/heads/main', 'refs/heads/feat/hobo-ci-production'],
});
const pending = await ci.applySetup(setup.id);
console.log(pending.result?.pullRequestUrl);
// After that PR passes the repository's normal merge policy:
const current = await ci.getPolicy();
await ci.connectSetup(setup.id, { revision: current.revision });
```

The server discovers the repository ID and default branch. It selects the sole
bound installation automatically; accounts with multiple installations select
one returned by `getInstallations()`. Omitted branch allowlists default to the
repository's default branch. Explicit allowlists can include the branch under test.
Create an account policy before preparing a repository.

Preparation verifies the App, installation permissions, installation/repository
association, repository ID and App bot identity. The reviewed plan contains only
the shipped host workflow and bootstrap source. Applying creates a deterministic
setup branch and PR; it does not bypass default-branch protection. GitHub's normal
review policy controls merging. Retrying an uncertain setup discovers the same
branch/PR rather than blindly duplicating it. A reused branch with extra changes
is refused.

Connection verifies the merged bytes and pins a dedicated locked, administrator-
enforced bridge branch. It verifies the pin and protection again before committing
the account connection. Automatic setup installs `.hobo-ci/bootstrap.mts`, which
works even when the customer repository declares CommonJS. The relay origin is
rendered into the reviewed host workflow, so a repository variable is not required.
Clients refer to a server-owned setup operation ID for apply/connect; they cannot
submit replacement bootstrap files. Setup state survives journal rebuild/restart,
and a late apply result cannot regress a ready connection to pending.

## Account routing and operations

| Method | Account endpoint | Required scope |
| --- | --- | --- |
| GET | `/v1/accounts/self/policy` | `policy:read` |
| GET | `/v2/accounts/self/runtime` | `policy:read` |
| PUT | `/v2/accounts/self/policy` | `policy:write` plus current revision |
| PUT | `/v2/accounts/self/providers` | `policy:write` plus current revision |
| GET | `/v1/accounts/self/installations` | `policy:read` |
| POST | `/v1/accounts/self/repositories/prepare` | `repositories:write` |
| GET | `/v1/accounts/self/repositories/{operation}` | `policy:read` |
| POST | `/v1/accounts/self/repositories/{operation}/apply` | `repositories:write` |
| POST | `/v1/accounts/self/repositories/{operation}/connect` | `repositories:write` plus current revision |
| GET | `/v1/accounts/self/leases` or `/leases/{id}` | `policy:read` |
| POST | `/v1/accounts/self/leases/{id}/reconcile` | `operations:write` |

The last endpoint accepts generated `ReconcileRequest` JSON containing a verified
`hostRunId`. It still checks the host's identity, protected source, provider label,
completion and runner cleanup. It cannot force-release running or ambiguous work.
Lease/event lists return at most 100 account records. Account IDs are taken from
authentication, and foreign repository/lease access fails before provider mutation.
On Vercel, the runtime endpoint returns the Sandbox enablement flag, loaded
allowed-domain patterns, and deployment ID for the process serving the request.
It does not report credentials, URLs, or settings of an individual runner.

`putPolicy(account, {revision})` changes budgets and publishes fresh allocation
facts without restarting the relay. Configuration and its audit event commit
atomically in the lease journal. Read models, setup records and policy can be rebuilt.
Changing/removing an active provider identity or repository bridge pin is refused;
drain the existing hosts before rotating those identities. A connection revoked
while webhook REST validation is awaiting cannot admit new demand under its old
binding.

By default, routing selects eligible offers that consume measured free allocation
first, choosing the lowest projected paid charge among them. When no eligible offer
can consume free allocation, routing selects the cheapest paid offer. A partial free
balance can leave a paid remainder more expensive than a fully paid host. Pricing
and allocation evidence must cover the entire reserved host duration, including
any extra Sandbox proxy VM duration. The relay
reserves worst-case runtime plus startup, checks account/provider budgets and concurrency, and rechecks delayed
launches. Original Actions jobs and portable native pipelines share the ledger.
Prices use integer USD microdollars; allocations use normalized runner minutes.

Allocation snapshots are trusted platform/provider inputs, not discovered vendor
entitlements. `Offer.freeMinutes` is remaining free allocation at `observedAt`;
`Offer.spentMicros` already includes all completed usage through that inclusive
watermark. `Account.spentMicros` uses the same semantics when `usageObservedAt`
is supplied. Only later completed local usage is added. Settlement records actual
usage completion separately from late reconciliation, preventing double charging
when a refreshed snapshot already includes that work. Snapshots cannot move
backward or place account usage in the future. Expired price/allocation evidence
refuses admission until refreshed; unknown balances are never assumed free.

For a Vercel Sandbox offer with `freeMinutes` zero and no `sandboxAllowance`,
an account token with `observations:write` may call `reattestRate` to extend
only the expiry of the existing rate evidence. The publisher must first check
the complete current pricing and estimate every billed component against the
offer's `sourceUrl`. Pass the offer ID, source URL, check time and new expiry,
along with the current configuration revision. The check time must be at most
five minutes old and the new expiry at most 24 hours after it. The operation
records the publisher's assertion in the audit log; the relay does not fetch or
verify vendor prices. It preserves the usage watermark, spend, rate card and
all budget settings. An offer with any free entitlement requires a fresh
complete allocation observation instead. Expired evidence continues to refuse
admission until a trusted publisher refreshes it. The estimate is not a hard
cap on the provider invoice, and a shared vendor credit is not an exclusive
free allocation.

The publisher must supply complete snapshots and normalized prices for all billed
components. Provider-native spending controls remain the external billing ceiling.
Admission budgets do not migrate or terminate a running GitHub job mid-step.

## Supported runner hosts

| Provider | Host selected by the relay |
| --- | --- |
| GitHub | Configured GitHub-hosted Linux x64 label |
| Blacksmith | Account-connected Blacksmith Linux x64 label |
| Depot | Account-connected Depot Linux x64 label |
| WarpBuild | Account-connected WarpBuild Linux x64 label |
| Kubernetes | Operator-owned isolated, disposable Linux x64 host runner label |

These are implementations of the reviewed companion-workflow/JIT host protocol.
They do not assume undocumented vendor APIs accept GitHub credentials. Each provider
must be connected to GitHub with its supported label and supply accurate budget
inputs. A Kubernetes host is a disposable runner machine, not a nested privileged
Docker socket exposed by the relay. The relay image itself executes no customer jobs.

Provider connection requirements apply independently of HoBo. Blacksmith,
Depot GitHub Actions runners and WarpBuild require organization-owned repositories;
they cannot run a personal-account repository merely by adding an offer to HoBo.
See the [Blacksmith quickstart](https://docs.blacksmith.sh/introduction/quickstart),
[Depot runner overview](https://depot.dev/docs/github-actions/overview) and
[WarpBuild migration guide](https://www.warpbuild.com/migrate/github-hosted-to-warpbuild).
The Vercel relay currently enables only the isolated Sandbox host and refuses this
companion-workflow bridge. The bridge hosts listed here are supported by the
separate trusted-repository relay, not live provider connections on Vercel.

The workflow bridge requires a private repository with a repository-wide trusted
execution boundary. Private visibility alone does not establish this boundary:
everyone who can start a workflow or submit a fork pull request that can execute
with `runs-on: hobo` must be trusted with the host environment and its credentials.
GitHub matches labels, not a requested job ID; refusing provisioning for an event
does not prevent another queued matching job from claiming an already registered
runner. The host and nested runner share a provider machine, so the bridge cannot
isolate untrusted workloads. See [GitHub's self-hosted runner security guidance](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners).

Public repositories and PR provisioning are refused, even when public repository
acknowledgment is set. Drain registered runners before changing a private repository
to public: GitHub visibility changes cannot be made atomic with a relay admission
check.

OIDC audience, repository, run attempt, workflow path/SHA, App bot actor, provider
label and lease title are verified before JIT registration. JIT is single use.
Bootstrap checks the official runner archive checksum, filters inherited credentials
and context, and waits for all executable descendants to stop after cancellation.
Settlement waits for verified outer-host completion and runner cleanup and includes
startup, idle and cleanup time. Actual runner attribution requeues displaced demand
without duplicate charging. Recovery paginates host discovery; ambiguous results
or exhausted discovery windows retain reservations for authenticated reconciliation.

## Portable pipelines

`createActionsBackend({workspace})` executes the common parsed pipeline in a bound
runner/act workspace; Dagger and Cloudflare implement the same portable command and
artifact contract. `@hobo/ci/scheduler` supplies account-bound allocation admission
for those contexts. Workers use `@hobo/ci/execution`; the Node journal stays outside
the Worker bundle. See [shared CI SDK](../ci/README.md).

Validation includes TypeScript, generated protobuf/CUE fixtures, HTTP/App/provider
Pacts, real process lifecycle tests, connected act acceptance, deployment conformance
and an actual nonroot container lifecycle. Live GitHub assignment and vendor
provisioning remain separate release evidence; failed permissions or missing JIT
must never be reported as a successful runner test.

The bound Actions/act command adapter delegates to the shared Node workspace
backend in `@hobo/ci/workspace-backend`. The Azure Pipelines sibling
[`@hobo/ci-ado`](../ci-ado/README.md) uses that same execution implementation;
GitHub relay, runner authorization and account routing remain in this package.
