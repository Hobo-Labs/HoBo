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

`@hobo/ci-gh-actions` provides the HoBo CI relay, account API, repository
installer and ephemeral GitHub Actions runner host. There is one relay; it is
[hosted three ways](#one-relay-thin-hosts) (a Node service behind `hobo ci serve`
and the container image, Vercel, and the box worker daemon), and each host adds
only a store, a scheduler and runner backends. Once the repository's setup
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
workflow execution, signed completion, runner cleanup and settlement. Six
original jobs consume four providers' free allocations, select the cheapest paid
provider and exercise provider-budget fallback. The exhausted account launches
no seventh job. Reopening and replaying the database preserves billing and results.
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
provider offers; CI minimizes the complete incremental cost by default.
The explicit `maximize-credits` objective prioritizes usable free allocation.
The highest active configured threshold wins. Recovery restores the lower or
normal profile, and an empty offer list pauses new admissions.

[The Station example](../stations/README.md#ci-budget-routing) shows the wiring.
Signal cycles and crossed state persist with account policy; delayed facts and
replay cannot undo a newer transition. CAS conflicts are retried by the journal
consumer, and `reconcile()` applies rule changes to existing signal state.
Already running jobs retain their reservation and finish on their chosen host.

## One relay, thin hosts

There is one relay. Its core is `HostedRelay` (`src/hosted-relay.ts`:
admission, reservation, dispatch, runner claim, reconciliation), driven by
`createHostedRelayRuntime` (`src/hosted-runtime.ts`: the durable webhook inbox
and the worker tick), with `createHostedControlPlane` (`src/hosted-control.ts`:
the account API) and `createRelayHandler` (the HTTP surface, below). They are
written against the `HostedInboxStore` port, which `SqliteCiStore` and
`PostgresCiStore` in [`@hobo/ci`](../ci/README.md) both implement.

A host supplies a store, something that calls `runtime.tick`, and runner
backends. Nothing else differs between them:

| Host | Entry | Store | What calls the tick | Runner backends |
| --- | --- | --- | --- | --- |
| Node service: `hobo ci serve`, the container image | `createRelayHost` (`src/relay-host.ts`), started from `HOBO_CI_*` by `startRelayFromEnvironment` (`src/main.ts`) | `SqliteCiStore`, one file fenced by a lock file | A 5-second timer in `createRelayService` | Workflow bridge |
| Vercel | `createVercelApplication` in [`@hobo/ci-vercel`](../ci-vercel/README.md) | `PostgresCiStore` | A queue wake-up per delivery and a 15-minute schedule | Vercel Sandbox |
| Box worker daemon | `scripts/isolated-worker-daemon-main.mts` (no HTTP; admission by polling) | `SqliteCiStore` or `PostgresCiStore` | Its own loop | Isolated containers |

With pull admission, `hobo ci serve` feeds the Node service's inbox from
`createGithubJobPoller` (`src/isolated-worker/github-job-poller.ts`), the same
poller the box worker runs; there is no second poller.

The Node service adds two things of its own to the shared handler: a cached
readiness probe that also gates admission (`admitWhenReady`: while the probe
fails or the service drains, a delivery answers 503 for GitHub to redeliver and
a runner claim is refused; the account API stays reachable), and a bounded
drain on SIGTERM. The Vercel host adds the GitHub App bootstrap and OAuth
onboarding, the queue wake-up and the webhook and queued-job repair; those are
Postgres-only today and the Node service does not have them.

What a host can turn on, and who does:

| Option | Node service | Vercel |
| --- | --- | --- |
| `ingressForwardSecret` (`X-Hobo-Ingress-Forward` intake) | `HOBO_CI_INGRESS_FORWARD_SECRET` | not configured |
| `trustProxy` (refuse a plain-HTTP forward) | `HOBO_CI_TRUST_PROXY=1` | not configured |
| `stubEngines` (health of engines it does not serve) | `HOBO_CI_STUB_ENGINES` | none |
| `fullAccountUpdates` (`PUT /v1/accounts/self/policy`) | on | off (410) |
| `isolatedHost` (Sandbox runner; also lets a desired policy name a Sandbox provider) | none | Vercel Sandbox |
| `denyUnisolated` (no workflow bridge) | off | on |
| MCP `sessions` (see [MCP server](#mcp-server)) | `memory`: sessions, streams and resource subscriptions | `none`: every request stands alone |

Everything else, routes included, is the same code with the same behaviour:
the `/engines/gh-actions` mount and the per-engine health map are served by
every host, and the v2 runtime, providers, rate-observation, observation and
inbox routes and `isolated-connect` are served by the Node service too.

## One HTTP layer

Every host of the relay serves the same Fetch handler, `createRelayHandler`
(`src/http-handler.ts`). A Node server or function entrypoint puts
`createNodeRelayHandler` (`src/node-http.ts`) in front of it. The handler owns:

| Route | Behaviour |
| --- | --- |
| `GET /healthz`, `GET /readyz` | Process liveness and readiness, each with an `engines` map (`gh-actions` plus any stub engine the host declares) |
| `GET /engines/{stub}/healthz`, `/readyz` | Health of an engine the host reports but this relay does not serve |
| `/engines/gh-actions/…` | The same routes as the root |
| `POST /github/webhooks` | Signed delivery intake; the delivery is committed before it is acknowledged |
| `POST /v1/leases/{id}/jit` | Runner claim with a GitHub OIDC bearer |
| `/v1/accounts/self/…`, `/v2/accounts/self/…`, `/v1/app-registration/…` | Handed to the host's control plane |
| `/mcp` | The relay's [MCP server](#mcp-server) (Streamable HTTP), when the host mounts one |

A delivery is authenticated by GitHub's `X-Hub-Signature-256`, or, when the host
configures an ingress forward secret, by `X-Hobo-Ingress-Forward` from
[`createWebhookIngressHandler`](src/webhook-ingress.ts). Both are the same
HMAC-SHA256 over the exact body bytes and are checked by one function,
`verifyWebhookSignature` in `src/webhook-signature.ts`; nothing else in the
package compares a webhook signature. With `trustProxy`, a request whose
`X-Forwarded-Proto` is not `https` is refused with 403.

`contracts/http-boundary.pact.json` pins this boundary and is executed by
`contracts/http-boundary.provider.test.ts` through the Node adapter;
`test/http-handler.test.ts` covers the engine mount, the forward and the proxy check.

## MCP server

The relay is an MCP server (Model Context Protocol, Streamable HTTP) at `/mcp`
and `/engines/gh-actions/mcp`, so an agent can read job state, be told when it
changes, and act on it without polling the account API or setting itself a
reminder. It is one module, `createRelayMcp` (`src/relay-mcp.ts`, tools and
resources in `src/relay-mcp-server.ts`, views in `src/relay-mcp-views.ts`),
built on the official `@modelcontextprotocol/sdk` (`McpServer` over
`WebStandardStreamableHTTPServerTransport`) and mounted by every HTTP host
through `HostedRelayApplication.mcp`. A host that mounts none answers 404.

### Authentication and scope

`/mcp` takes the account API's bearer credentials, resolved by the same
`ControlAuthenticator`. Every request is authenticated, including each request
of a session.

| Refusal | Answer |
| --- | --- |
| No or unknown credential | 401 `{"error":"account authentication required"}` with `WWW-Authenticate: Bearer` |
| Credential holds neither `policy:read` nor `operations:write` | 403 `{"error":"account scope required"}` |
| `Origin` header that is not the relay's public origin | 403 `{"error":"origin not allowed"}` |
| Body over 1 MiB | 413 `{"error":"request body too large"}` |

The account comes from the credential, never from an argument. A tool or
resource sees only that account's leases, queued jobs and events; another
account's lease is reported as `lease not found`, exactly like one that does
not exist. Read tools and every resource need `policy:read`; a tool that
changes something needs `operations:write`. A caller without a tool's scope
gets a tool error naming it, and the operation is not attempted. The writes
call the same functions as the account API (`src/account-operations.ts`), so
the ownership checks are written once.

The `Origin` check is the DNS-rebinding guard: a browser page on another
origin cannot drive a relay on `localhost`. The SDK's own
`allowedHosts`/`allowedOrigins` options are deprecated in favour of a check in
front of the transport, which is what this is. `Host` is not compared: the
Node adapter already resolves every request against the configured origin.

### Tools

| Tool | Scope | What it does |
| --- | --- | --- |
| `list_leases` | `policy:read` | The account's leases, newest first. Filters: `state`, `repository`, `runId`, `activeOnly`; `limit` 1 to 200 (default 50) |
| `get_lease` | `policy:read` | One lease by id, with its latest 20 events found among the account's newest 500 |
| `list_pending_jobs` | `policy:read` | Jobs queued for the account's repositories that have no lease yet. Filter: `repository` |
| `list_events` | `policy:read` | Events after `cursor`, oldest first; without a cursor, the newest. Filters: `leaseId`, `repository`, `types` |
| `wait_for_events` | `policy:read` | Blocks until an event after `cursor` matches the filters, or `timeoutSeconds` passes. Returns `{events, cursor, timedOut}` |
| `get_relay_status` | `policy:read` | Readiness, engines, whether this host pushes resource updates, and the wait default and ceiling |
| `reconcile_lease` | `operations:write` | `POST /v1/accounts/self/leases/{id}/reconcile`: settle a lease against a verified `hostRunId` |
| `list_quarantined_webhooks` | `operations:write` | The account's quarantined deliveries (identity and attempts, never the body) |
| `retry_quarantined_webhook` | `operations:write` | Put one quarantined delivery back in the inbox |

The inbox tools need `operations:write` to read as well as to retry, as the
account API's `/v2/accounts/self/inbox/…` routes do.

### Resources

| Resource | Content (`application/json`) |
| --- | --- |
| `hobo-ci://leases` | The account's 100 newest leases |
| `hobo-ci://leases/{leaseId}` | One lease and its latest events |
| `hobo-ci://events` | The account's 100 newest events and the cursor to read on from |

Results are protobuf JSON of the `RelayMcp*` messages in
[`data-models/relay_mcp.proto`](data-models/relay_mcp.proto), written with zero
and empty fields present. Each view is assembled field by field: a lease view
carries no sandbox identity or budget digest, an event view carries the
event's type, time, lease, repository and job and never its stored detail,
and no view can carry a credential or a JIT configuration, which the relay
does not journal. CUE closes the views, and two invalid fixtures pin that a
`detail` or a sandbox identity does not fit.

### Following job state

Every lease and job change is an event appended to the store's journal in the
transaction that makes it (`ci.JobQueued`, `ci.LeaseReserved`,
`ci.DispatchRequested`, `ci.RunnerClaimed`, `ci.HostSettled`,
`ci.LeaseUncertain`, `ci.LeaseCancelled`, `ci.LeaseExpired`, `ci.JobExpired`,
`ci.JobCompleted` and the rest). The MCP feed is a projection over that event
store, read with the store's cursor (`eventsSince`, see
[`@hobo/ci`](../ci/README.md#event-cursor)); it is not a second bus, and it
replays from any cursor because the journal is the source.

**`wait_for_events` on every host.** Call it with the `cursor` of your last
result. The relay polls its own journal once a second inside the call and
answers as soon as there is a matching event, or with `timedOut: true` and the
cursor to continue from. Without a cursor it waits for what happens next.

```text
list_events {}                                   -> { events: […], cursor: "412" }
wait_for_events { cursor: "412", leaseId: "…" }  -> { events: [ci.RunnerClaimed], cursor: "415", timedOut: false }
wait_for_events { cursor: "415", leaseId: "…" }  -> { events: [], cursor: "415", timedOut: true }
```

The wait is 25 seconds unless `timeoutSeconds` says otherwise and never more
than 50: under the 60-second default request timeout of the MCP TypeScript
SDK's client, and within a serverless function limited to one minute. At most
32 calls wait at once in one process; one more is refused with a tool error
to retry. A caller that hangs up, or cancels the request, ends its wait.

**Resource subscriptions on a host that keeps sessions.** With
`sessions: "memory"` the server advertises `resources.subscribe`. Subscribe to
`hobo-ci://events`, `hobo-ci://leases` or `hobo-ci://leases/{leaseId}`, keep
the session's event stream open (`GET /mcp`), and the relay sends
`notifications/resources/updated` for a subscribed resource when the
account's journal moves; read the resource for the change. One pump per
process reads the journal for the accounts that have a subscriber, and stops
when the last subscription goes.

| | Node service (`hobo ci serve`, container) | Vercel |
| --- | --- | --- |
| `sessions` | `memory` | `none` |
| Tools and resources | yes | yes |
| `wait_for_events` | yes | yes |
| `resources/subscribe` and `notifications/resources/updated` | yes | not advertised |
| Responses | event streams (`/mcp` is a streaming path of the Node adapter) | JSON |
| `GET /mcp`, `DELETE /mcp` | the session's stream; end the session | 405 |

The box worker daemon has no HTTP listener and serves no MCP; an agent reads
its leases through whichever HTTP host shares its store.

A session belongs to the account that opened it: another account naming its
id gets 404, as for an unknown id. The Node service holds at most 64 sessions
and 16 for one account (429 beyond that), closes a session that has no open
stream and has made no request for 15 minutes, and closes every session and
stream when it drains. A process restart ends its sessions; a client
initializes again and continues from its last cursor, which the journal still
answers. On Vercel a wait occupies the function for its duration, so the
project's function duration limit must be above the 50-second ceiling.

### Client configuration

An HTTP MCP server entry, with the account token read from the environment
(never written into the file):

```json
{
  "mcpServers": {
    "hobo-ci": {
      "type": "http",
      "url": "https://<relay-origin>/mcp",
      "headers": { "Authorization": "Bearer ${HOBO_CI_ACCOUNT_TOKEN}" }
    }
  }
}
```

`contracts/mcp-boundary.pact.json` pins the boundary every host honours and is
executed by `contracts/mcp-boundary.provider.test.ts` through the Node
adapter; `test/relay-mcp.test.ts` drives the SDK's own client against the
shared handler for each tool and resource, account isolation, the wait and its
timeout on an injected clock, and sessions, subscriptions and their limits.

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
reports local partition readiness (the store answers and holds a configuration)
and becomes unavailable during drain. A dispatch or runner claim that a crash
interrupted is marked uncertain by the worker tick once it is two minutes old,
never retried.
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
`initializeHostedRelaySchema(pool)` creates every PostgreSQL table the hosted
relay's GitHub stores use (App registration, OAuth sessions, platform App
bootstrap, webhook repair and queued-job repair) by running the same
initialisers each store runs on first use, and stores nothing. The Vercel
adapter calls it to give a standby database the schema of the serving one.

The Vercel host supplies the App bootstrap and OAuth callbacks described
below; they are Postgres-only today, so the Node service (`hobo ci serve`, the
container image) does not serve them and takes an existing App's ID, key and
webhook secret from its `HOBO_CI_*` bindings instead. Customer repository setup is handled by the
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
An optional `store` picks the isolated worker's lease journal for
`hobo ci serve --with-worker`: `{ "kind": "sqlite" }` (the default, a local file
that polls GitHub for `runs-on: hobo` jobs) or
`{ "kind": "postgres", "urlEnv": "DATABASE_URL" }` for a shared relay partition.
`urlEnv` names an environment variable; the schema refuses a connection string.
Amounts are USD microdollars. Each policy still requires separately provisioned
providers and a repository connection on its selected relay.

The [project JSON Schema](schema/ci-project.schema.json) defines the configuration
format using JSON Schema draft 2020-12. The example's `$schema` annotation points
editors to that schema, and the package exports it as
`@hobo/ci-gh-actions/schema/ci-project.schema.json`. The parser uses its shipped
schemas and never fetches the `$schema` URL while loading configuration.

### Provider shapes

A policy provider is one of eight closed, kind-specific shapes defined in the
sibling [provider schema](schema/ci-project-providers.schema.json) (exported as
`@hobo/ci-gh-actions/schema/ci-project-providers.schema.json`). The project
schema's `Provider` is a relative `$ref` to that file, which is a `oneOf` with
`additionalProperties: false` on every branch. Every kind carries the base
fields `id`, `kind`, `connectionRef`, `runsOn` and optional `enabled`; existing
five-field providers of every kind except `vercel` stay valid unchanged.

| Kind | Extra fields |
|---|---|
| `local`, `github`, `blacksmith`, `depot`, `warpbuild`, `hobo-box-worker` | none; `scaleSet`, `engine` and `location` are rejected |
| `kubernetes` | optional `scaleSet` **or** optional `engine` (never both); neither keeps the existing disposable-pod path |
| `vercel` | required `location`: `vercel`, `local` or `remote`; `scaleSet` and `engine` are rejected |

`scaleSet` names an [ARC](https://github.com/actions/actions-runner-controller)
`AutoscalingRunnerSet`: `{ "name", "namespace", "maxRunners", "minRunners"? }`.
`name` is the set's `runnerScaleSetName` and must equal the provider's `runsOn`
(checked when the policy is applied, not when the file is parsed); `name` and
`namespace` are DNS labels and `minRunners` (default 0) may not exceed
`maxRunners`. `engine` is `{ "name" }` of a Dagger Engine whose readiness HoBo
checks. HoBo never installs or upgrades ARC or Dagger. Neither shape accepts a
kubeconfig, token or `githubConfigSecret`: cluster and Vercel credentials stay
out of `.hobo/ci.json` and resolve through the `connectionRef`.

```json
{
  "id": "arc",
  "kind": "kubernetes",
  "connectionRef": "yard:build-cluster",
  "runsOn": "hobo-arc",
  "scaleSet": { "name": "hobo-arc", "namespace": "arc-runners", "maxRunners": 4 }
}
```

The TypeScript types (`CiProjectProvider`, `CiKubernetesProvider`,
`CiVercelProvider`, …) are inferred from the same discriminated union in
`src/project-providers.ts`; `pnpm --filter @hobo/ci-gh-actions schema:check`
fails when either shipped file drifts. The protobuf `CiPolicyProvider` carries
the shapes as a `capacity` oneof (`scale_set` | `engine`) plus `location`, CUE
constrains them in `@hobo/ci`'s `ci.cue`, and `parseCiPolicy` rejects a shape on
the wrong kind. A relay keeps reading persisted vercel policies whose protobuf
`location` is empty; only authored files require it.

References are optional. Each pool, routing policy, budget, provider entry and
secret-requirement map accepts either a complete inline definition or a `$ref`.
You can mix both forms in the same environment and duplicate inline definitions
across environments. Omit `definitions` entirely when everything is inline.
In a complete environment policy, both forms receive the same validation and
resolve to the same policy. Template/`extends` fragments are the exception:
their inline pool/routing/budget fragments may be partial, while `$ref`
targets and `definitions` entries must be complete. `budgetPolicy` has no
registry and is always inline.

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

`putPolicy(account, {revision})` (`PUT /v1/accounts/self/policy`) replaces the
whole account, offers included, so it is served only where the operator owns
the provider inventory: the Node service enables it (`fullAccountUpdates`), for
accounts that have no v2 desired policy; the Vercel host answers 410 and takes
`putDesiredPolicy` only. It changes budgets and publishes fresh allocation
facts without restarting the relay. Configuration and its audit event commit
atomically in the lease journal. Read models, setup records and policy can be rebuilt.
Changing/removing an active provider identity or repository bridge pin is refused;
drain the existing hosts before rotating those identities. A connection revoked
while webhook REST validation is awaiting cannot admit new demand under its old
binding.

By default, `min-cost` selects the lowest complete projected paid charge. Explicit
`maximize-credits` prefers offers that consume measured free allocation before
comparing paid remainders. A partial free balance can leave a paid remainder more
expensive than a fully paid host. Pricing
and allocation evidence must cover the entire reserved host duration, including
any extra Sandbox proxy VM duration. The relay
reserves worst-case runtime plus startup, checks account/provider budgets and concurrency, and rechecks delayed
launches. Original Actions jobs and portable native pipelines share the ledger.
Prices use integer USD microdollars; allocations use normalized runner minutes.
The relay reprices held offers with their pinned attempt and queue context, retaining
other payer measurements for all-of constraints. This preflight checks feasibility;
the durable store must still claim the financial hold and revalidate strict native
liability proof before dispatch. A feasible plan cannot authorize provider effects.

The isolated-worker daemon accepts `HOBO_CI_TRUSTED_BUDGET_ADAPTER` as an
operator-controlled absolute path to a local `.js` or `.mjs` module. This is
trusted host code, never a repository or job setting. Its exported
`createCiWorkerBudgetAdapter({ kind })` returns `{ kind, options, close? }`,
where `kind` matches the daemon store (`sqlite` or `postgres`) and `options`
is the corresponding `@hobo/ci` shared-budget options object. The options must
provide the same durable Broker authority used by hosting and a trusted quote
publisher that binds the full provider account, price and execution plan. For
PostgreSQL workers the parent authority must be shared PostgreSQL; a local
SQLite authority cannot coordinate distributed hosts. For SQLite workers the
parent authority must use a separate database file from the worker journal.

Strict policies additionally require a provider-native liability verifier;
credit allocations, settlement and unused holds require their respective trusted
coverage, final-usage and cancelled-before-claim verifiers. Missing proof refuses
the effect or keeps the hold. The daemon validates the adapter through the common
hook factory, redacts adapter errors, and closes it during shutdown or failed
startup. With no adapter, common-policy admission remains fail-closed. Supplying
an adapter is an operator integration and does not certify provider billing.

Allocation snapshots are trusted platform/provider inputs, not discovered vendor
entitlements. `Offer.freeMinutes` is remaining free allocation at `observedAt`;
`Offer.spentMicros` is the trusted usage total at that watermark.
`Account.spentMicros` uses the same semantics when `usageObservedAt` is supplied.
Local completion at the same timestamp remains conservatively counted until a
strictly newer observation covers it. Settlement records actual
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

## Tracing

The box worker exports OpenTelemetry traces when `OTEL_EXPORTER_OTLP_ENDPOINT` or
`HOBO_CI_TRACE_FILE` is set: one span for each GitHub call that changes something and one for each
structured log event, grouped by workflow run. `createRelayTrace`, `traceGithubTransport` and
`relayTraceSinkFromEnv` are exported for other hosts of the relay. See
[Tracing in the runner queue runbook](../ci/RUNNER-QUEUE.md) for the settings, the span list and how
to tell who cancelled a run.

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

Event/ref allowlists and `ci.attempts` constrain the original demand admitted to
request a host. They do not constrain the actual matching job GitHub assigns to
that shared-label runner. The reservation covers account and host liability.
Use an independently verified isolated execution target when actual-job, ref,
or attempt isolation is required.

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

## Postgres schema

The 13 PostgreSQL tables this package owns (App registration, OAuth sessions,
the platform-App bootstrap fence, and the webhook and queued-job repair state)
are declared in [`db/schema.ts`](db/schema.ts). Their migrations are in
`db/migrations/`, generated and applied with the tooling `@hobo/ci` provides:
`pnpm --filter @hobo/ci-gh-actions run db:generate`, `db:check`, `db:migrate`
and `db:verify`. The stores still create their tables from the DDL embedded in
`src/`; `db/migrations/embedded-ddl.lock.json` and `db:verify` hold that DDL to
the declared schema. How a migration is produced and applied, how an existing
database is baselined, and what is not done yet are described once, in
[`@hobo/ci`](../ci/README.md#postgres-schema-and-migrations).
