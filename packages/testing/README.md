# @hobo/testing

The out-of-box application test harness: deploy a collected Bindle topology,
assert against it, tear it down. This is the package GAP-026 / HOBO-705
reserved a hook for — "no equivalent of Aspire's whole-graph in-process
harness" — and ADR-0159 committed a contract for.

```ts
import * as runnerModule from "vitest";
import { bindHarnessLifecycle, createTestHarness, createVitestRunnerAdapter } from "@hobo/testing";
import { app } from "./bindle.js";

const runner = createVitestRunnerAdapter(runnerModule);
const harness = createTestHarness({ runner });          // lane defaults to "in-process"
bindHarnessLifecycle(runner, harness, app);             // deploy in beforeAll, destroy in afterAll

runner.test("the api answers", async () => {
	const graph = await harness.deploy(app)();            // memoized: deployed once per suite
	await harness.untilReady("api");
	const response = await fetch(`${graph.http("api").baseUrl}/health`);
	expect(response.status).toBe(200);
	expect(graph.fidelity().prodReadinessClaimable).toBe(false); // and the report says why
});
```

Swapping to `node:test` is a two-line change: `import * as runnerModule from
"node:test"` and `createNodeTestRunnerAdapter(runnerModule)`. Nothing else in
the suite moves.

## HONEST SCOPE

Read this section before you believe a green suite.

**The in-process lane does not execute real `.wasm` component bytes.**
`@hobo/runtime-local` cannot execute them today. What the lane actually does:

- parses the collected Bindle structurally and orders it dependencies-first;
- for every HTTP-shaped alias (`api`, `web`, `service`, `ui`) whose collected
  entrypoint factory resolves to a fetch handler, opens a **real `node:http`
  listener on an ephemeral loopback port** and adapts requests through the
  platform `Request`/`Response` types — so real application code runs and real
  HTTP crosses the wire;
- resolves binding values for the whole graph through `runtime-local`'s
  `createLocalBindingResolver`;
- tears everything down in reverse dependency order.

What it does **not** do:

- run the deployed artifact on the deployed host — hence handles are labelled
  `simulated`, never `real`;
- provide an engine behind `data`, `kv`, `bucket`, `queue`, `topic`, `secret`,
  `auth`, `crypto`, `flag`, `job`, `schedule`, `websocket` or any other
  non-HTTP kind. Those get a handle and a `hobo-test://` binding locator and
  nothing behind them. They are labelled `mocked`. Labelling them `simulated`
  because an in-memory map *could* back them would be the overclaim, since
  nothing on `DeployedGraph` exposes such a store;
- exercise `container` or `wasm-component` resources at all — labelled
  `camp-only`;
- contact a provider, broker a credential, or write to `.hobo/`.

**The `ephemeral-camp` lane's gates are implemented; its provisioning is not.**
`createTestHarness({ lane: "ephemeral-camp", yard })` really does require an
explicit Yard and a brokered credential locator in
`HOBO_TESTING_CAMP_CREDENTIAL_REF`, and refuses each missing piece with its own
code. `deploy()` then refuses with `HARNESS_LANE_UNIMPLEMENTED`. It never
degrades to `in-process`: a suite that believes it hit real providers and
actually hit a loopback stub is worse than a suite that failed.

**`prodReadinessClaimable` is not a pass/fail flag.** It is false whenever any
handle the suite reached for was `mocked`. In practice that means most suites
today cannot claim prod-readiness from this lane alone — which is the honest
answer, not a defect of the harness. A bare green tick over mocked handles is
the overclaim GAP-026 was filed against, and ADR-0159 calls emitting one a
conformance failure of the harness itself.

**Deploy caching is memoization, not the event store.** ADR-0159 §3 wants an
unchanged plan content-hash to make `deploy()` a no-op apply against the
durable event store. Here `deploy(bindle)` is memoized per bindle for the life
of the harness object; nothing is persisted between processes.

**`createTestHarness` takes an optional second argument** (`{ probe, env }`)
used to inject the readiness probe and the environment for the credential gate.
It is a test seam for this package's own suites; the documented call form is
the single-argument one in §1.6 of the harness contract.

## When to use this vs the neighbouring packages

| Question you are answering | Package |
|---|---|
| "Does my app's topology come up, answer, and tear down?" | **`@hobo/testing`** — whole-graph deploy → assert → destroy |
| "Does my adapter honour the port it claims to implement?" | `@hobo/conformance` — port/adapter conformance suites, plus the provider scratch harness for create/update/replace/delete/adopt/crash-resume |
| "Do the two sides of a service boundary still agree?" | `@hobo/contract-harness` — PACT consumer/provider verification |

They compose rather than compete: a provider passes `@hobo/conformance`, the
boundary it exposes is pinned by `@hobo/contract-harness`, and an application
built on both is exercised end to end by `@hobo/testing`.

## Surface

- `createTestHarness(options?)` → `{ deploy, destroy, untilReady }`.
  `deploy(bindle)` and `destroy(bindle)` return **thunks**, so they drop
  straight into `beforeAll`/`afterAll`.
- `DeployedGraph` → `outputs()`, `resource(alias)`, `http(alias)`,
  `fidelity()`.
- `untilReady(target, { attempts = 20, initialDelayMs = 500 })` — bounded
  exponential backoff capped at 5s per wait. Retries propagation-shaped
  failures (404, 408, 425, 429, any 5xx, network throws) and **fails fast on
  400/401/403**: an auth rejection is an answer, not a propagation delay. Any
  other 4xx is likewise treated as an answer.
- Runner adapters: `createVitestRunnerAdapter`, `createNodeTestRunnerAdapter`,
  `detectRunner`, `requireRunner`, `bindHarnessLifecycle`. Detection is
  environment-based and **fails closed** — `HARNESS_RUNNER_UNDETECTED` with
  remediation rather than a guess at hook names.
- Lane primitives, exported so a suite can assert on them directly:
  `deployInProcess`, `destroyInProcess` (returns the teardown order it walked),
  `parseEphemeralCampTarget`, `deployEphemeralCamp`.
- Graph primitives: `parseTestTopology`, `deploymentOrder`, `teardownOrder`.
- Fidelity: `FIDELITIES`, `inProcessFidelity`, `CAMP_ONLY_KINDS`,
  `HTTP_SERVED_KINDS`, `emptyFidelityCounts`.

No Effect-TS, Polly or XState on the public surface (ADR-0136) — plain
async/await and typed results.

## Parse, don't validate

Every value that crosses into this package from the outside goes through a
parse boundary that returns a frozen, derived domain type or throws a
`TestHarnessError` with a `code` and required `remediation`. There is no
partially-valid result and no boolean validator anywhere in the package.

| Parse boundary | Input | Derived type |
|---|---|---|
| `parseTestTopology` | `bindle: unknown` (a collected Bindle definition) | `TestTopology` |
| `parseEphemeralCampTarget` | a Yard plus the process environment | `EphemeralCampTarget` |
| `parseRunnerAdapter` | an author-supplied runner adapter | `RunnerAdapter` |
| `createTestHarness` | lane and stage strings | `Lane`, stage slug |

The harness accepts `bindle: unknown` deliberately: `@hobo/testing` is a
layer-3 package that reads the collected shape structurally rather than
importing `@hobo/bindles`, so `parseTestTopology` is where the unknown becomes
a checked, derived type and nothing downstream re-checks it. Unresolvable
dependency edges (connectors, for example) are **recorded** on the topology,
never silently dropped — a discarded edge is a portability lie.

The protobuf records in `data-models/` are the wire form of these derived
types; the CUE file carries the invariants that make them load-bearing (an
endpoint may only appear on a handle that was actually served, and
`prod_readiness_claimable` is derived from the assertions rather than
asserted).

## Event architecture

This package is a test harness and owns no aggregate: it issues no command and
appends no event of its own. ADR-0159 §5 is explicit that the harness adds no
new event family — a harness run rides the existing `dev.*` and `deployment.*`
records. Where a suite runs against a real Camp, the deploy it triggers is a
command handled by the deployment actor, whose facts land in the durable event
store; projections over that stream build the materialized views the dashboard
and read store serve, with snapshots backing current status. The fidelity
report this package produces is a per-run derivation over live handles, not a
projection — it is deliberately not persisted, because a stored green tick
outlives the run that earned it.

## Contracts

- `data-models/test_harness.proto` / `.cue` — handle, fidelity report,
  deployed-graph and refusal records, plus the invariants above.
- `contracts/pacts/app-test-harness.pact.json` — the suite/harness boundary,
  including three refusal interactions: `HARNESS_YARD_REQUIRED` (no silent
  downgrade), `HARNESS_READINESS_REJECTED` (a 401 is an answer), and
  `HARNESS_CREDENTIAL_NOT_A_REF` (locators, never values — ADR-0113).
