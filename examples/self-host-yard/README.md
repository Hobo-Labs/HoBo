# self-host-yard

A HoBo example of **operating your own Yard**: instead of pointing the `hobo`
CLI at a provider-run control plane, the operator composes the whole control
plane — event store, actor host, executor, credential broker, provider
registry — in their own process, with the deployment event log in a SQLite
file on their own disk. A small **status-page bindle** (api + web) is planned,
realized, and torn down against that self-hosted Yard.

## The pieces

| File | What it is |
|---|---|
| `src/api.ts` | The status-page API — a plain fetch handler exposing `GET /status` and `POST /incidents`. |
| `src/webapp.ts` | The status page (plain fetch handler) bound to the API. |
| `src/bindle.ts` | The bindle config that wires web → api. |
| `src/yard.ts` | The self-hosting composition: `openSelfHostedYard({ dataDir })` builds the Yard runtime over the operator's disk and binds the composed `hobo` CLI to it. |
| `hobo.bindle.json` | The committed manifest artifact the cloud verbs read — byte-identical to the source compile (the tests assert it). |
| `test/` | Proves the app, the manifest parity, the topology, the plan/up/down lifecycle, the durable log across a control-plane restart, and the pact pin. |

```ts
const yard = openSelfHostedYard({ dataDir: "/var/lib/my-yard" });
await yard.cli.run(["plan", "--json"], { cwd: projectDir });
await yard.cli.run(["up", "--json"], { cwd: projectDir });   // -> deployed
await yard.cli.run(["down", "--json"], { cwd: projectDir }); // -> destroyed
yard.close(); // the event log stays in /var/lib/my-yard/eventstore.sqlite
```

## What "self-hosting the Yard" means here

`openSelfHostedYard` reuses `createDefaultYardRuntime` from `@hobo/hobo` — the
same composition root the composed `hobo` binary uses — and pins one thing:
`dataDir`. The runtime-local **event store** persists every deployment fact to
`<dataDir>/eventstore.sqlite` on the operator's machine. The tests prove the
consequence: after `up` and `down`, the process is closed, a **second** control
plane is opened over the same `dataDir`, and the full history
(`deployment.Requested` → `deployment.Planned` → `deployment.Deployed` →
`resource.Destroyed` → `deployment.RolledBack`) is already in its store; a bare
event store opened over the same directory reads the identical log. The
operator's disk — not a provider — is the source of truth.

The deployment is also described with HoBo's topology objects: one
`yard("home-yard", { provider, ... })` from `@hobo/yards` containing one
`camp("prod", ...)` from `@hobo/camps`. Provider selection lives ONLY on the
Yard (read from the runtime's own registry) — `@hobo/yards` **enforces**
one-provider-per-yard and `@hobo/camps` rejects Camps that own a Bindle or
select a provider (the tests show mixing providers throws). The Camp stays
provider-neutral; its runtime requirements record the operator's own disk as
the event-store substrate, and the status-page Bindle attaches via the
`deployment.Requested` the CLI issues.

## Honest scope

- **Local self-host lane only.** The IaC backend is the offline in-memory
  Pulumi-backed provider from the default composition — no real cloud calls,
  no credentials. Everything runs in-process on the operator's machine.
- **No remote federation.** Junctions (linking multiple Yards) is
  design-stage; nothing here talks to another Yard.
- **Restart = replay + re-plan, not resumed writes.** A restarted control
  plane reads the durable log and re-plans to the identical `planHash` (pure
  read paths). It does NOT append new facts in these tests: the default
  composition's manual clock makes event ids deterministic, so a fresh runtime
  appending to an old log would replay the same ids (the store's UNIQUE
  constraint refuses). The full `up`/`down` write lifecycle therefore runs on
  one control-plane instance; widening restart-append needs a clock seam the
  composition root does not expose yet.
- **Compute-only bindle.** A kv-backed incident log would be the natural next
  resource, but data resources compiled through the TS-source loader lower to
  the generic `hobo:data` port, which no provider in the default registry
  advertises — `hobo plan` would reject it. The api + web components lower to
  the `compute` port and plan green.

## Run it

```bash
pnpm --filter @hobo/example-self-host-yard test
```

## How this maps to HoBo's architecture

The status API is protobuf-first: its shapes live in `data-models/status.proto`
with matching CUE constraints in `data-models/status.cue`, and `src/api.ts`
imports the **generated** `ComponentStatus`/`StatusPage`/`IncidentReport`/
`IncidentAck` types from `src/_generated/status_pb.ts` (run
`buf generate data-models --template ../../buf.gen.yaml -o src/_generated` to
regenerate). Following **parse, don't validate**, untrusted incident JSON
crosses a single parse boundary (`parseIncidentReport`) that returns the
**derived domain type** (`IncidentReport`) instead of re-checking raw fields
downstream.

The self-hosted control plane is genuinely event-driven: `hobo up` is a
**command**; the gateway appends `deployment.*` **events** to the durable
**event store**; choreographed resource **actors** provision each resource
(`resource.*` facts) with no central coordinator; teardown folds the same
stream into per-resource **snapshots** of actor state to walk
reverse-dependency order. Honest scope: the deployment-view **projection**
(the **materialized view** in `@hobo/cloud` that folds the stream into a
**read store** for `hobo inspect`) exists in the production packages but is
not exercised by this example's tests — `collectStream` over the deployment
stream is the only read surface asserted here. The operator ⇄ Yard boundary
(`up` realizes, `down` destroys) is pinned by the executable PACT in
`contracts/pacts/operator-to-yard.pact.json`.

## Maintenance

Lifecycle tests fail explicitly when deployment responses omit resource lists before iterating them.
