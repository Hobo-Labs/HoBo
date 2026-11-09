# @hobo/hobo

For repository CI, run `hobo ci connect`; see [CI setup and command reference](CI.md)
for Git remote detection, isolated runner consent, account credentials, run logs,
retries, and the documented Vercel CLI parity.

**Product composition root** for the end-user `hobo` CLI (and `hobo-mcp`).
This package is the composed product binary; **`@hobo/cli`** is the shell,
parser, registry, and command factories. Un-injected factories fall back to
intentional stubs; this package supplies the default runtimes so lifecycle verbs
run end to end in-process.

```ts
import { createComposedHoboCli } from "@hobo/hobo";

const cli = createComposedHoboCli();
await cli.run(["up", "--json"], { cwd: projectDir });
```

- `createComposedHoboCli(options?)` — the composed CLI (one shared YardRuntime
  across plan/up/down; login uses the broker-aware handler; new/build/codegen
  use the `@hobo/cli` handlers).
- `createDefaultYardRuntime(options?)` — the default cloud runtime.
- `createDefaultDevRuntime(options?)` — the default offline dev runtime.
- `createDefaultCollectionTarget(projectDir?)` — the default collect target.

Composed binaries: `dist/bin/hobo.js` (product `hobo`) and `dist/bin/hobo-mcp.js`.
`createDefaultYardRuntime()` without a `dataDir` keeps its throwaway event store in a
`hobo-yard-*` directory under `TMPDIR` that the process owns and removes when it exits,
an uncaught error included (`src/owned-temp-dir.ts`). The `hobo` binary instead passes a
persistent data directory under `HOBO_HOME`; `hobo-mcp` and `createComposedHoboCli()`
use the temporary default. A `dataDir` you pass is yours and is never removed. As entry
points, the binaries also remove owned temporary directories (and the live Pulumi lane's
workspace) on SIGTERM, SIGHUP, SIGINT or SIGQUIT (`removeOwnedDirsOnSignals`). Another
entry point that composes this CLI in its own process asks for the same removal through
that export of `src/cli.ts`.
When nothing else in the process listens for the signal, the directories are removed and
the signal raised again, so the process still ends by it (status 128+n). When something
else handles the signal (`hobo serve control` stops gracefully on SIGTERM and SIGINT and
exits 0), that handler decides how the process ends, and the directories are removed on
`exit`. The library itself installs no
signal handler, so a host that embeds it keeps its own signal handling. SIGKILL and a
crash are out of reach.
Canonical verb list: **42** verbs in `@hobo/cli` (`packages/cli/src/shell/verbs.ts`).

## CLI verification and remote deployment safety

### Budgeted cloud hosting

`createHostingBudgetAuthorityBridge` connects `@hobo/cloud` planning and durable
hosting transitions to the broker's shared SQLite budget authority. The host
supplies tenant-scoped planning evidence, independent revalidation, a trusted
clock, and final provider-account/entitlement settlement evidence. Paid charges
and shared credits are reserved together before deployment facts are published.
Each charge stays with its source or destination billing account; credit scope
and cost class remain part of the pinned plan.

Execution adopts the gateway's existing reservation through an atomic claim.
Another transition cannot spend the same authorization. A lost provider response
keeps the hold until observation establishes the outcome; settlement requires
retirement and final usage evidence. The default offline runtime does not infer
provider prices, billing bounds, or final invoices. A hosting integration must
supply these trusted ports and the effects/resilience-aware execution adapter.

`test/hosting-budget-authority.test.ts` composes the actual gateway, transition
journal and two SQLite authority connections. It covers admission races, shared
free allocation, tampering, restart, reservation adoption and final settlement.
The wire contracts and CUE/PACT fixtures live with `@hobo/cloud` and
`@hobo/broker`; these offline tests do not verify a live provider API. See the
[hosting transition design](../../docs/design/hosting-budget-transitions.md).

`createProductionYardRuntime` is the async production composition. It requires a
caller-owned persistent directory and trusted clock. `configureHosting` receives
the same SQLite event partition used by the gateway and returns the actual provider
registry, authoritative budget bridge and execution configuration. Credential
leases and signed native financial readers can be acquired asynchronously before
any provider effect. The returned `hostingController` supports status, bounded
resume, cancellation and explicit bounded mutation resumption; `close()` closes
the event store without deleting its persistent directory.

`createResolverHostingTransitionProvider` drives shipped provider resolvers and
Station routing. Every source and destination resource requires independently
verified provider-funded or native finite-term liability evidence before the first
mutation. Soft quotas and local timers cannot prove a hard financial bound. A
successful move cannot release its hold while destination liability remains open.
A source or destination's native serving endpoint must also match the active
Station backends. Health probes use the same endpoint origin and serving path;
multiple routed endpoints require an explicit probe for each (`additionalUrls`).
A healthy response from another service cannot authorize routing. Missing native
ingress, including an IAM-only function without an observed HTTP ingress, refuses
cutover. Stock resolver execution supports stateless moves with pinned data;
state transfer requires a workload adapter that proves checkpoints, checksums and
write fencing, and is refused before mutation when that adapter is absent.

Final reconciliation remains available after a write deadline. Retirement requires
positive terminal absence and final billing evidence, including the exact native
physical identity; a 404 and a DELETE acknowledgement alone cannot settle a hold.

Native target names and durable resource receipts include tenant, deployment and
transition incarnation. Existing sources name their approved `sourceIncarnationId`;
a decommission names the creation transition of the target it retires. This prevents
an old delayed DELETE from destroying a newer deployment with identical content.
App Platform sibling component writes also serialize on the whole native parent
using a shared SQLite CAS lock. A lost response retains that lock; clock expiry
never unlocks an unknown native write.

### Self-hosted control plane

The embedded local broker is the default. Hosted brokers, hosting relays, and
hosted identity services are not prerequisites for local placement or serving.
A network broker is selected only through `--broker`/`--broker-uri`,
`HOBO_BROKER`/`HOBO_BROKER_URI`, or an explicitly saved profile association.
That endpoint can be self-hosted; "remote" describes transport, not a mandatory
hosted service. There is no automatic fallback to a hosted broker.

`test/self-hosted-broker.test.ts` runs local placement with remote
discovery/client factories unavailable. `test/persistent-local-deployment.test.ts`
executes the product binary in separate processes: `up` returns a reachable app,
unchanged `up` reuses the running lease, changed source or build artifacts replace
the worker, and `down` closes it. Local anonymous and
temporary launches have an expiry timer (one hour by default). Host toolchains
may need to be installed or downloaded separately. Anonymous/temporary flags
alone do not select a hosted broker; without an explicitly configured network
broker, the command remains local.
Local deployment operations use an OS-released SQLite lock, so an interrupted
or killed CLI cannot leave a permanent lock that blocks subsequent launches.
An application probe returning a server error rejects deployment and closes
the worker before a receipt or control token is persisted.
Auth.md credential lifecycle operations serialize local reads, remote key
changes, and persistence under the same kind of lock; simultaneous rotations or
deployment associations cannot overwrite newer credential state.
Cloud-provider deployment still requires the selected provider's API, but it
does not imply a hosted HoBo broker or relay requirement.

`test/command-inventory.test.ts` checks every canonical command is wired and
offers offline help. Command-specific tests exercise successful operations and
refusals; help alone does not establish deployment readiness.

Remote placement and claim endpoints must remain on the selected broker's
origin and contain no URL credentials (`HOBO_BROKER_ENDPOINT_UNSAFE`). Anonymous
session discovery may use a separate HTTPS host, but placement credentials and
claim tokens cannot be forwarded there. Session, placement, and claim POSTs
refuse redirects. `test/broker-remote-*.test.ts` pins this HTTP boundary.
Cloudflare/Vercel credentials select exact-resource resolvers unless an explicit
Pulumi adapter or live Pulumi setting takes precedence. `HOBO_DEPLOY_RESOLVERS`
is retained as a compatibility spelling and no longer selects fixture uploads.

`identity agent discover|register|status|claim|poll|token|rotate|revoke` exposes
`@hobo/auth-md` in the composed CLI. An explicitly selected broker can advertise
its protected resource through `resourceMetadataUrl`; a matching registration
then authenticates placement through a real `private_key_jwt` token exchange.
Human login, agent-principal claim, and infrastructure claim remain independent.
Infrastructure claim gates further agent management on the required key rotation;
revocation refuses further token exchange and placement. Credentials stay in
owner-only local files. `test/auth-md-https.test.ts` proves the complete flow over
self-hosted HTTPS, including scope refusals, replacement-key proof, and revocation.
See [auth.md CLI configuration](../auth-md/README.md#cli-integration).

Local launch, receipt, and lifecycle event payloads have executable
Protobuf/CUE contracts in `data-models/composition.*`. Credential material stays
in separate owner-only files; receipts and lifecycle facts contain references.
Live provider acceptance requires a reachable target and that provider's
credentials when applicable.

## Deployment and build execution

Without a selected live cloud backend, product `up` hosts the source Bindle in
a persistent self-hosted worker using the existing local Yard serving engine.
The CLI returns only after a real HTTP readiness probe. Authenticated loopback
control verifies lease and process identity for reuse and shutdown. Temporary
expiry closes the server and records teardown. No broker or relay account is
needed. `hobo dev --serve` remains the foreground development loop.

Explicit cloud configuration selects the existing live IaC providers.
`createDefaultYardRuntime` also remains available for explicitly injected
deterministic library fixtures; product `up` does not treat its in-memory backend
as a live deployment. IaC selection lives in `src/compose.ts`:

| Path | When |
|---|---|
| Persistent local Yard worker | Product default with a loadable source Bindle |
| In-memory Pulumi stand-in | Explicitly injected library/test runtime |
| Real Pulumi Automation/CLI | `HOBO_PULUMI_LIVE=1` (engine- and credential-gated); its programs and `file://` state go in `HOBO_PULUMI_WORKDIR`, which is kept, else in a `hobo-pulumi-live-*` directory removed when the process ends (one `hobo:` line on stderr names it), so set `HOBO_PULUMI_WORKDIR` to keep the state |
| Direct-HTTP Cloudflare resolver plane | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; production hosting configuration required |
| Direct-HTTP Vercel resolver plane | `VERCEL_TOKEN` (and `VERCEL_TEAM_ID`, or `VERCEL_ORG_ID`, for a project in a team); production hosting configuration required |

The Vercel fixture helper (`src/vercel-deploy-provider.ts`,
`createVercelDeployProvider({ fixtureArtifact: true, token })`, which
`selectIacProvider` never picks) deploys first, with one
`POST /v13/deployments`. Only when Vercel refuses that because the project
does not exist (404 `not_found`, "Project not found") does it create the project
with `POST /v9/projects` and deploy once more. A 409 there whose `error.code` is
`conflict` means it was made meanwhile, and a refusal of the deployment after it
names that 409's reason (the reason cut at 200 characters, the note kept whole,
and the refusal's own text cut to leave it room); any other 409 is a refusal
like any other. So its first deploy from an account that has never seen the
project deploys instead of failing, and a deploy to an existing project is one
request. Any other refusal, or a second one, is a `VercelApiError` carrying
Vercel's status, `error.code` and `error.message`. A response body can echo the
request, and the executor keeps an error's message, so the error's `message` and
`apiMessage` have the token, and anything bearer- or credential-shaped, replaced
by `[redacted]`, and each is cut at 500 characters (a `…` marks the cut). The
token is looked for as sent; in base64, alone, as a Basic header's `:token`, and
as the part of a longer base64 value (such as `Bearer token`'s) that depends on
the token alone; as the base64 of its base64; and as the base64 of its
percent-encoding (`%XX`, either case). In each of those, every character may be
written as itself (a `/` also as JSON's `\/`), as a JSON escape `\uXXXX` (hex
in either case, after one backslash or more, as in JSON inside a JSON string),
percent-encoded byte by byte as `%XX` or, encoded twice, as `%25XX` (either
case), or as an HTML numeric reference, `&#xNN;` or `&#NN;` (either case, any
number of leading zeros, the `;` optional). A run of whitespace (a newline,
`\r\n`, spaces, tabs), control characters (NUL, ESC, DEL, NEL), format
characters (a soft hyphen, a zero-width space or joiner, a word joiner) or any
other default-ignorable code point (a variation selector, a combining grapheme
joiner, a Hangul filler), which a message shows as spaces or not at all, may
sit anywhere in it, inside an encoding too. A JSON body is also parsed and its strings, keys included,
searched before it is written back out; any other body, or one too deep to
write back out, is searched as text. The token is looked for again after the
rest of the redaction has run, so nothing it does brings the token back. The
error's `code` is kept only when it is a short identifier (letters, digits, `_`, `.` and `-`, at
most 64 characters, and nothing the redaction would change), and is otherwise
undefined. A request that gets no answer to read (the transport throws or
rejects, or a 2xx body cannot be read) is a `VercelTransportError`: its
`message` names the call and says what was thrown, down its `cause` chain and
into an `AggregateError`'s `errors` (eight parts at most), redacted and cut the
same way, and it keeps nothing of what was thrown, so it has no `cause`. A 2xx
body that is not JSON is named by a fixed reason, `response body was not JSON`,
and nothing of the body is quoted (a runtime's JSON error quotes its start, cut
short). A token that holds whitespace, or a control, format or other default-ignorable
character (CR, LF and NUL among them), is refused when the client is made,
before any request, by an error that does not quote it. A credential binding's
scope needs `POST` on `/v13/deployments`, and `POST` on `/v9/projects` for that
first deploy; it needs no `GET` on the project.

The project is created in the scope `teamId` names, or in the token's own scope
when there is no `teamId`. Vercel answers "Project not found" for a project that
lives only in another scope, so a missing `teamId`, or a wrong one the token can
still deploy to, does not fail: it creates a second project of that name there
and deploys to it. Set `teamId` (`createVercelClient({ token, teamId })`, or the
helper's `teamId`) for a project that lives in a team. `selectIacProvider`, and
so `hobo up`'s Vercel resolver plane, reads it from `VERCEL_TEAM_ID`, beside
`VERCEL_TOKEN`, else from `VERCEL_ORG_ID`, the Vercel CLI's name for
it, when that is a team id. The CLI writes a personal account's id
there too, and the Vercel CLI treats an `orgId` that starts with `team_` as a
team and any other as the user (its `getOrgById`, in
`packages/cli/src/util/projects/get-org-by-id.ts` of vercel/vercel); so does
this, and a `VERCEL_ORG_ID` that does not start with `team_` is taken as no
team. A bare `team_`, with nothing after it, names neither, and is refused
before anything is sent, with an error that names `VERCEL_ORG_ID`. So is a
`VERCEL_TEAM_ID` that is not a canonical `team_…` id — a slug or a name: the
resolvers compare it with the canonical `accountId` Vercel returns, so a slug
would read as a different team on every later read, after a create succeeded. Every entry
point (`createVercelClient` and `createVercelDeployProvider` too) takes a team
id trimmed, and takes an empty or blank one as none: with none, the deploy and
any create are in the token's own scope. The resolver plane's project lookups
and creates carry that `teamId`. A run whose credentials
come from OpenSesame (`HOBO_CREDENTIALS=opensesame`) keeps them too: the
relaunched `hobo` starts from `@hobo/adapter-opensesame`'s allowlisted
environment, and `VERCEL_TEAM_ID` and `VERCEL_ORG_ID`, team or account ids and
not credentials, are on that allowlist. The helper's outputs say what happened:
`projectCreated` is `"true"` when this deployment created the project and
`"false"` otherwise, and `scope` is the `teamId`, or `"token-default"` when
there is none: the scope Vercel gives a request with no `teamId`, which for a
team's token need not be a personal account.

**Credentials from OpenSesame (`HOBO_CREDENTIALS=opensesame`, [ADR-0170](../../docs/design/adr/02-identity-security.md#adr-0170)).**
The composed `hobo` then relaunches itself once, before composing anything, as
`opensesame dev --agent --schema <generated> run -- <this invocation>` (through
[`@hobo/adapter-opensesame`](../adapters/adapter-opensesame/README.md)), reading
`hobo.credentials.json` (references only) from the directory the verb works in
(`--cwd`, else the working directory), and exits
with the run's status: the command's own, 77 for a tripwire, 128+n for a signal,
1 for a run that left placeholders or never started. The relaunched process
holds an `osr_` surrogate in `VERCEL_TOKEN`; `selectIacProvider` refuses anything
else with `OPENSESAME_PLACEHOLDERS_ONLY` before any request (it runs when the
runtime is composed, so a placeholder run stops there with status 1). Vercel only; AWS is
not brokered. `src/credentials-opensesame.ts`. An invocation that runs no verb
(`--help`, no verb, an unknown verb or option) needs no credential: it is answered
without starting OpenSesame, composed with none.

`hobo-mcp` relaunches the same way (its tools run the same verbs), stdin and stdout
passing through to the relaunched server, but only with `OPENSESAME_STORE_PASSWORD`
in its environment: its stdin is the MCP stream, which OpenSesame would otherwise
read the store passphrase from. Without it, it starts nothing and exits 1 with one
`hobo: OPENSESAME_STORE_PASSWORD_REQUIRED` line. The library entry points
(`createComposedHoboCli`, `createDefaultYardRuntime`, `openBareMetalYard`) never
relaunch; outside a proxied run they throw the typed `OpenSesameCredentialsError`
when the runtime is composed.

The relaunch gets only the Node options that read no environment or code from disk
(`src/relaunch-node-options.ts`): `node --env-file=.env hobo up` does not re-read
`.env` in the run, and `--require`, any `--import` but hobo's own TypeScript loader,
and `--inspect` are left out too, from the command line and from `NODE_OPTIONS`, and
named on one `hobo:` line. A relaunched process that still holds another provider's credential
(`CLOUDFLARE_API_TOKEN`, `AWS_*`, `PULUMI_ACCESS_TOKEN`, … beside its surrogate) is
refused with `OPENSESAME_CREDENTIALS_BESIDE_SURROGATE`, which names the variables and
never their values. `HOBO_PULUMI_LIVE=1` is refused there too
(`OPENSESAME_LANE_NOT_BROKERED`): the live Pulumi engine authenticates with credentials
found outside OpenSesame, which only brokers Vercel's token.

Related execution paths:

- **`hobo login`** — fixture/OIDC session under `HOBO_HOME`; full production OIDC/SPIRE is not the default (`src/login-command.ts` `HONEST SCOPE`).
- **Build paths** — compiler-backed app imprints produce real Node bundles with
  runtime assets. Product WASM builds require the real componentizer; product
  container builds use a service Dockerfile with Docker Buildx or self-hosted
  BuildKit (`HOBO_CONTAINER_BUILDER=buildctl`). OCI archives include actual
  manifests, configuration and filesystem layers, with blob hashes and rootfs
  diff IDs verified. All output files and the manifest are replaced together
  after successful generation. Toolchain failures preserve the previous build.

**Pre-release:** `@hobo/hobo` is **not published to npm** as a stable install story yet. Prefer the monorepo workspace binary until publish hygiene and CI-proven release land. Ship targets: [`docs/design/launch-ship-targets.md`](../../docs/design/launch-ship-targets.md), [ADR-0140](../../docs/design/adr/07-portability-extensibility.md#adr-0140).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for layering and runtime assembly.

Validate integration changes with `pnpm --filter @hobo/hobo run test`. Vitest loads workspace packages' built `dist` exports through Node rather than re-transforming that dependency graph through Vite; hobo's own source and tests still use the Vite loader. `@hobo/cli` stays on the Vite loader so dynamic bindle imports resolve `.js` specifiers in TypeScript sources.

## Local substrate auto-discovery (`src/local-substrates.ts`)

`seedLocalhostYard()` (`@hobo/yards`, ADR-0157) gives a default localhost
Station exactly one Yard — `yard:local` — decided from capability observations
alone. That seed is substrate-blind: it does not know whether this machine can
run WASM, OCI containers, a WSL2 guest, LXC/Incus, systemd-nspawn, or
Firecracker microVMs. `local-substrates.ts` supplies that axis and registers a
Yard per *available hosting substrate*, so the Station reflects what the box can
actually host.

```ts
import {
  defaultLocalSubstrateProbes,
  registerLocalSubstrateYards,
} from "@hobo/hobo";

const { report, yards } = registerLocalSubstrateYards({
  probes: defaultLocalSubstrateProbes(),
  observations: stationCapabilityObservations,
});
```

- `LOCAL_SUBSTRATE_KINDS` — closed, frozen vocabulary: `firecracker`, `lxc`,
  `nspawn`, `oci`, `process`, `wasm`, `wsl2`.
- `defaultLocalSubstrateProbes(env?)` / `parseLocalSubstrateProbes(input)` — the
  only host access. Discovery itself is **pure over the injected probes**: no
  `process.env`, no `execSync`, no network, no clock, no randomness. Tests
  describe a whole machine as data.
- `discoverLocalSubstrates(probes, { now? })` — frozen report, one finding per
  kind, sorted by kind. Two calls with the same probes are deep-equal.
- `localSubstrateYards(report, { observations? })` / `registerLocalSubstrateYards`
  — Yards named `yard:local-<kind>` (`process` keeps `yard:local` and reuses the
  seed's own Yard record). `process` and `wsl2` reuse `seedLocalhostYard()`'s
  rows rather than duplicating its row table.
- `LocalSubstrateError` — typed, fail-closed refusals
  (`LOCAL_SUBSTRATE_PROBES_INVALID`, `LOCAL_SUBSTRATE_REPORT_INVALID`,
  `LOCAL_SUBSTRATE_KIND_UNKNOWN`, `LOCAL_SUBSTRATE_EVIDENCE_MISSING`), each
  carrying a `remediation` naming what to change.

### Detection rules and evidence

| Substrate | Present when | Evidence rows |
|---|---|---|
| `process` | always (this code runs in one) | `platform:<p>`, `node:<version>` |
| `wasm` | a toolchain binary (`wasmtime`/`wasmer`/`wasmedge`/`jco`) **or** Node >= 20's `WebAssembly` embedder | `bin:<path>`, `node-webassembly:<version>` |
| `oci` | a client binary (`docker`/`podman`/`nerdctl`) **or** an engine socket | `bin:<path>`, `sock:<path>` |
| `wsl2` | Linux **and** `/proc/version` carries the `WSL2` kernel marker | `file:/proc/version`, `file:/run/WSL`, `env:WSL_INTEROP`, `env:WSL_DISTRO_NAME`, `file:/proc/sys/fs/binfmt_misc/WSLInterop` |
| `lxc` | Linux **and** an `lxc`/`lxd`/`incus` binary or daemon socket | `bin:<path>`, `sock:<path>` |
| `nspawn` | Linux **and** `systemd-nspawn` on PATH **and** `/run/systemd/system` | `bin:<path>`, `file:/run/systemd/system` |
| `firecracker` | Linux **and** the `firecracker` binary **and** `/dev/kvm` | `bin:<path>`, `dev:/dev/kvm` |

`firecracker`, `lxc`, `nspawn`, and `wsl2` are Linux-only: on any other platform
they are reported absent with the platform as the reason and **no** evidence,
because nothing was probed.

### ADR-0042 fidelity per substrate

| Substrate | Fidelity | Why |
|---|---|---|
| `process` | seed rows (`real` / `simulated`) | reuses `seedLocalhostYard()`, whose labels are already audited (Node HTTP server `real`, in-memory queue `simulated`) |
| `wsl2` | seed rows (`real` / `simulated`) | detected from *inside* the guest, so hosting is the same in-process Node executor as `yard:local` |
| `wasm` | `simulated` | `runtime-local` does not execute real `.wasm` bytes today ([`docs/design/yard-bindings.md`](../../docs/design/yard-bindings.md)); a `wasmtime` binary on the box does not change what HoBo executes |
| `oci` | `camp-only` | `@hobo/runtime-oci` schedules through kubectl against a cluster; there is no path that places a workload into the local daemon |
| `lxc`, `nspawn`, `firecracker` | `camp-only` | the substrate is genuinely on the box, but HoBo has no local placement path — satisfying the profile needs a Camp |

### HONEST SCOPE (substrate discovery)

Discovery reports **evidence**, not working capability. Specifically:

- **A binary on PATH is not a running daemon.** `docker` or `lxc` on PATH proves
  the client exists; the engine may be stopped, remote, or unauthorized. When
  only a client is found, the finding's `detail` says "client binary only".
- **A socket on disk is not a reachable, authorized daemon.** No request is ever
  made — no network, no `execSync` — so an engine socket proves a path exists at
  a well-known location, nothing about whether a container would start.
- **`/dev/kvm` existing is not read/write access to it**, and `systemd-nspawn`
  plus a live systemd is not root privilege.
- **WSL1 vs WSL2** is distinguished only by the `WSL2` marker in the kernel
  string. When WSL interop is observed without that marker, the weaker claim is
  reported (`present: false`, evidence kept) rather than an unproven v2.
- **Node's `WebAssembly` embedder runs core modules, not components.** Without a
  toolchain binary the `wasm` finding says exactly that.
- **No substrate row means HoBo executes there.** Only the `process`/`wsl2` rows
  (inherited from the seed) are backed by an executor in this repo; everything
  else is `simulated` or `camp-only` on purpose.

## Resolver-backed deploy lane (`src/resolver-iac-provider.ts`)

`@hobo/core`'s `hobo.resource-resolver/v1` plane calls provider REST APIs
directly — no IaC engine, no state file. Until this module existed it stood
*beside* the deploy path rather than behind it: `cloudflareResolverRegistry()`
and `vercelResolverRegistry()` were reachable from a test and from nothing else.
`createResolverBackedIacProvider()` puts the plane behind `@hobo/cloud`'s
`IacProvider` port, so `hobo up` / `down` / `drift` can drive it.

```ts
import {
  createFetchHttpTransport,
  createResolverBackedIacProvider,
} from "@hobo/hobo";
import {
  cloudflareResolverRegistry,
  guardedCloudflareTransport,
} from "@hobo/provider-cloudflare";

const iac = createResolverBackedIacProvider({
  store,                        // the durable store holding `deployment.Planned`
  registry: cloudflareResolverRegistry({ accountId, resolveCredential }),
  transport: guardedCloudflareTransport(
    createFetchHttpTransport(globalThis.fetch),
  ),
  credentialRef: "hobo-token://cloudflare/api-token", // a LOCATOR, never material
});
```

`IacProgram` is a thin execution descriptor and carries no desired state, so —
exactly like `src/pulumi-iac-provider.ts` — desired state is **recovered from the
durable `deployment.Planned` fact**, never fabricated: the plan node's
`productId` keys the resolver lookup (ADR-0157) and its `realizationParameters`
become `ResolveRequest.desired`.

### Selection precedence (`selectIacProvider`)

1. an explicit Pulumi `adapter` override, or `HOBO_PULUMI_LIVE=1` → the Pulumi
   lane (unchanged);
2. no cloud credential at all → the library runtime's in-memory Pulumi backend;
   product `up` uses the persistent local source-Bindle path instead;
3. a cloud credential → the exact-resource resolver plane (Cloudflare when
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` are set, else Vercel).

The committed hello-bindle upload helpers require explicit `fixtureArtifact:true`
and are never selected by environment. Their teardown performs native deletion
and an independent absence read; missing receipts and uncertain deletion refuse.
Existence alone reports content drift rather than claiming verified artifact identity.

### Fail-closed refusals (`ResolverIacError`, each with a `remediation`)

| Code | Fires when |
|---|---|
| `RESOLVER_IAC_PLAN_MISSING` | the deployment stream carries no `deployment.Planned` fact |
| `RESOLVER_IAC_RESOURCE_UNPLANNED` | the stored plan has no resource by that name |
| `RESOLVER_IAC_PRODUCT_UNDECIDED` | the plan node carries no `productId` |
| `RESOLVER_IAC_SLOT_UNDECIDED` | the node's capability port is outside the slot vocabulary |
| `RESOLVER_IAC_PRODUCT_UNREGISTERED` | no resolver is registered for that product |
| `RESOLVER_IAC_OUTPUT_RESERVED_KEY` | a resolver output would collide with the `hobo.resolver.` namespace |

`productId` and `realizationParameters` exist only on plans built with Yard
binding authority. **Absent means "not decided here", never "any product will
do"**, so a node without one is refused — the product is never inferred from the
port or the provider id, which is the naming-convention inference ADR-0144
forbids.

### Outputs, diff, and drift

`ResolveOutcome.outputs` land in `IacOutputs` under their own keys (non-string
JSON values are JSON-encoded rather than dropped; encoding is deterministic
because `parseResolveOutcome` sorts keys by code unit). The outcome's own
metadata lands under a reserved `hobo.resolver.` namespace:
`…contract`, `…action`, `…physicalId`, and `…diagnostics` (a JSON array, present
only when the resolver emitted any). A resolver output inside that namespace is
refused rather than shadowed.

### HONEST SCOPE (resolver deploy lane)

- **Nothing here has run against a live provider.** The whole module is proven
  against an *injected fake* transport modelling a provider account. A live
  deploy additionally needs real credentials, real network egress, and a real
  account — none of which a unit test supplies.
- **`preview` never claims zero changes it did not verify.** `IacDiff.changes`
  is a bare count with no "unknown", so a preview that could not look reports
  `RESOLVER_PREVIEW_UNDETERMINED` (`-1`) and says so in the summary. It reports
  `0` only when every declared parameter was observed *and* matched, except a
  **directive** that `read()` reports nothing for. A directive is a parameter
  the resolver lists in `ResourceResolver.directives` because it says how apply
  or delete acts rather than what the resource is (`restoreScheduled`,
  `forceDelete`; ADR-0175). Such a key is left out of the comparison, and the
  summary names it ("every compared declared parameter matches … Not compared:
  restoreScheduled …"). A directive key that `read()` does report is compared
  like any other. A resolver with no `read()` is always undetermined; so is a
  declared parameter that is not a directive and that the provider's read
  surface has no counterpart for (the change count is then a lower bound, and
  the summary says so).
- **`refresh` errs toward drift.** `IacDriftReport.drift` is a boolean with no
  "unknown" and `drift: false` is the claim "I looked and it matches", so
  anything unverified is reported as drift with
  `hobo.resolver.drift.determined = "false"` and a reason. The one exception is
  the same as preview's: a directive that `read()` reports nothing for is not
  state, so it is left out and named in `hobo.resolver.drift.reason` ("Not
  compared: …") instead of turning the report into drift. For a machine reader
  the same keys are in `hobo.resolver.drift.notCompared`, a sorted JSON list
  present only when a key was left out.
- **No state of its own.** This driver threads no `physicalId`, so convergence
  rests entirely on each resolver's deterministic-name lookup. The visible
  consequence is that a re-apply reports `adopt` rather than `noop` — honest,
  since the run neither created the resource nor knew its id.
- **`destroy` refuses what it cannot route.** "Already gone" at the provider is
  success (the resolvers treat a 404 that way), but a teardown whose plan cannot
  be recovered throws rather than reporting a green no-op over a real, billed
  resource.
- **No credential material anywhere.** `credentialRef` is a locator the host
  resolves at call time; provider error text is redacted by the resolvers
  themselves (`redactCloudflareText` and the Vercel equivalent) and re-raised
  here rather than re-redacted.
- **Preflight reports the resolver lane separately from the backend.**
  `describeDeployTarget` returns `lane: "resolver"` for credentialed
  Cloudflare/Vercel regardless of the deprecated `HOBO_DEPLOY_RESOLVERS` flag. It does not model explicit
  Pulumi adapter overrides or `HOBO_PULUMI_LIVE=1`; use `selectIacProvider`
  precedence above to determine those paths. Credential presence and a
  preflight `live` flag do not establish provider authorization or readiness.

## Local server and guest execution checks

`serve control` removes both signal handlers when either shutdown signal fires,
and propagates close failures to the command rather than producing an unhandled
rejection. `test/serve-control-command.test.ts` exercises binding, shutdown on
either signal, and returned URLs; it does not directly assert listener counts
or inject a close failure. The WASM guest execution test also checks tenant
environment injection through the separately bundled guest entry, which host
typechecking cannot cover.
