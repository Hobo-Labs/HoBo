# @hobo/hobo — composition-root architecture

`@hobo/hobo` is HoBo's **product composition root** (apps layer, layer 3) and the
package that ships the end-user `hobo` / `hobo-mcp` binaries. `@hobo/cli` remains
the shell, factories, and un-injected stubs; this package injects default
runtimes so cloud and local-loop verbs run end to end.

## Layering (apps -> adapters -> sdk/runtime -> core)

```
@hobo/hobo (apps, L3)
  ├─ @hobo/cli        (L3)  command factories + createHoboCli
  ├─ @hobo/cloud      (L3)  gateway, orchestrator, executor, registry
  ├─ @hobo/bindles    (L3)  collection target types
  ├─ @hobo/data       (L3)  in-memory actor host
  ├─ @hobo/runtime-local        (adapter, L2)  event store, component host, streamer
  ├─ @hobo/provider-cloudflare  (adapter, L2)  capability provider
  └─ @hobo/core       (core, L0)  shared ports/types
```

Importing the L2 adapters here is INWARD (L3 → L2) and therefore boundary-legal.
That is precisely why the default wiring lives at this root: adapter-free
`@hobo/cli` must not import an infra adapter, so it accepts an injected runtime
and the composition root supplies the concrete one.

## Product local execution and cloud runtime assembly

Product `up` defaults to a persistent self-hosted local worker. The worker
reuses `serveProjectOnLocalYard`, publishes its receipt after a real HTTP probe,
and exposes authenticated loopback control for lease reuse and shutdown.
Source and artifact fingerprints distinguish reuse from a real code update;
changed code replaces the old worker through its authenticated shutdown path.
Anonymous/temporary leases expire inside the worker; remote brokers and relays
are optional. The control token is stored separately with owner-only access.
`deployment.LocalStarted` and `deployment.LocalStopped` facts use the existing
durable EventStore.

`createDefaultYardRuntime()` assembles the cloud `YardRuntime`, also available
for explicitly injected deterministic fixtures. Its fields reuse existing
constructors:

- **event store** — `@hobo/runtime-local`'s file-backed **event store** with a
  manual clock. All deploy verbs share ONE store, so `up` then `down` fold the
  same durable log.
- **actor host** — `@hobo/data`'s in-memory host. Each resource is a
  choreographed **actor** whose state is folded from the **event** stream.
- **executor / IaC** — `@hobo/cloud`'s in-process executor over
  `selectIacProvider` (`src/compose.ts`). The library's unconfigured backend
  uses the Pulumi adapter's in-memory Automation API for fixtures. Product `up`
  uses persistent local hosting instead of reporting this backend as a live
  deployment. Explicit live paths are:
  - `HOBO_PULUMI_LIVE=1` → real Pulumi Automation/CLI engines (binary- and
    credential-gated)
  - Cloudflare / Vercel env tokens → credential-gated live deploy providers
- **credential broker + registry** — `@hobo/cloud`'s in-process broker plus a
  provider registry built from the real `@hobo/provider-cloudflare` provider
  (capability negotiation / `realize()`; live apply still follows the IaC
  selection above).

`createDefaultDevRuntime()` and `createDefaultCollectionTarget()` do the same for
`hobo dev` (runtime-local component host + Streamer, offline) and `hobo collect`.

## Event-sourced flow

The selected cloud lane issues a Deploy **command** through the gateway, which records
past-tense **events** into the shared **event store**. Resource **actors**
reconcile desired against observed state through the executor; the
`DeploymentView` **projection** (a **materialized view**) is rebuilt from those
**events** — with periodic **snapshot** folding — and serves the CLI's **read
store** queries. `hobo down` replays the same log to choreograph
reverse-dependency teardown to `deployment` destroyed.

## Parse, don't validate

Local launch, receipt and lifecycle event records live in the package's
Protobuf/CUE models and are parsed through generated messages. Consistent with
the repo rule, boundary payloads are turned into **parse, don't validate**
**derived types** at the seams they cross — the `@hobo/cli` yard-client and the
`@hobo/cloud` gateway own those parsers, and the composition root only hands them
already-parsed runtime objects. Actual persisted receipts and lifecycle payloads
are checked against these contracts in the process integration tests.

## How @hobo/iac-pulumi is wired (and what “default” means)

The default runtime **does** depend on `@hobo/iac-pulumi`. The kernel executor
still speaks its shape-A `IacProgram` execution descriptor; `createPulumiBackedIacProvider`
bridges that shape: it resolves each resource’s real `ResourcePlan` from the durable
`deployment.Planned` fact, lowers it with `provider.realize()` to a
`hobo.iac-program/v1` program, and applies it through the real Pulumi adapter.

The unconfigured library backend is the adapter's in-memory fixture backend.
`HOBO_PULUMI_LIVE=1` swaps the real Pulumi Automation API or pinned CLI engine.
The product's credential-free path hosts the app in the persistent local worker.
See [README.md](./README.md) for selection and lifecycle details.

## HTTP frameworks are L2 packages under `packages/adapters/`

`@hobo/hobo` / `@hobo/core` do **not** depend on Hono or other HTTP frameworks.

| Surface | What HoBo sees | Where frameworks live |
|---------|----------------|------------------------|
| local component host | bindle entrypoint as `(Request) => Response` | **`@hobo/runtime-local`** + **`packages/adapters/*`** |
| wasm host | bundles `src/<name>.ts` to wasi:http → Wasmtime OS sandboxes | **`@hobo/runtime-wasm`** |
| oci host | WASM packed as OCI, scheduled on Kubernetes via real kubectl client | **`@hobo/runtime-oci`** |
| cloud-native host | multi-cloud registry (mock + aws/gcp/azure/vercel/cloudflare stubs) | **`@hobo/runtime-cloud-native`** |
| mesh env | `x-hobo-env-*` when camp injects config | Camp mesh |

Host runtimes are **separate packages** under `packages/runtimes/*`. The composition
root dispatches via `serveProjectOnHost` / `getRuntimeHost`. Alias: `isolated-wasm` → `wasm`.

### External dependencies (Aspire-style)

Bindle authoring (`@hobo/bindles`):

| Factory | Runtime required | Discovery |
|---------|------------------|-----------|
| `b.external({ connectionString, endpoints })` | none (BYO) | links / public `services__*` endpoints only — **no** `ConnectionStrings__*` (ADR-0141) |
| `b.container({ image })` | **oci** | mesh + K8s Deployment |
| `b.wasmComponent({ source })` | **wasm** | wasmtime sandbox |
| `.withReference(...)` | — | alias of `dependsOn` |

Broker hard-fails when required runtimes are not installed:

```bash
hobo add runtime-wasm    # enable wasm host on this yard
hobo add runtime-oci     # enable oci/k8s host
hobo yard ensure         # equip toolchains
```

Missing install → `required-runtime-unavailable` (same plane as provider pins).

Adapters are **shared monorepo packages** for any project (`pnpm add @hobo/adapter-hono`).
Examples only *consume* them — adapter source does not live under `examples/`.

## Broker targeting + anonymous deploy (identity ≠ placement)

`createBrokerAwareUpCommand` resolves the target broker as:

1. `--broker` / `--broker-uri`
2. `HOBO_BROKER` / `HOBO_BROKER_URI`
3. `HOBO_HOME/profile.json` default from `hobo login --broker`
4. Local embedded broker / Yard event-sourced lane

The local broker is self-hosted; hosted brokers and hosting relays are optional.
A network URI describes transport and may point to a self-hosted service.
The local source-Bindle fallback probes its server and closes it before
returning; use `hobo dev --serve` for foreground serving. The no-remote-service
regression test checks that path, not a separately hosted broker HTTP server.

Remote paths **discover** first (`.well-known/hobo-broker`). Anonymous/`--temporary` requires `supportsAnonymous`. Claim rebinds ownership locally (event store) or remotely (`--broker` + `--token`) without re-provision. Human vs agent principals stay distinct: the credential presenter mints **real ES256 DPoP** proofs and audience-bound **JWT-SVIDs** (self-verified before send). Follow-ons: broker **server-side** DPoP verify, SPIRE Workload API fetch, WebAuthn human step-up.

