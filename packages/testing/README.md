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

Swapping to `node:test` is a two-line change: import its module as
`runnerModule`, then pass it to `createNodeTestRunnerAdapter`. Nothing else in
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
- exposes isolated local ports for queue, topic, secret, data, schedule,
  key-value, bucket, flag, experiment, and rollout aliases, with their actual fidelity on the handle;
- tears everything down in reverse dependency order.

What it does **not** do:

- run the deployed artifact on the deployed host; handles in this lane are
  never labelled `real`;
- provide an engine behind unsupported kinds such as `auth`, `crypto`,
  `job`, and `websocket`. Those get a handle and a `hobo-test://`
  binding locator and nothing behind them; they are labelled `mocked`. The
  resource catalog below lists every kind and its actual graph support;
- automatically wire local ports from the graph into an entrypoint.
  These are in-process ports, not services listening at the `hobo-test://`
  locator. A test must explicitly inject the port into the code under test;
- exercise `container` or `wasm-component` resources at all — labelled
  `camp-only`;
- contact a provider, broker a credential, or write to `.hobo/` using its
  built-in implementations. Custom factories execute caller-supplied code.

**The `ephemeral-camp` lane's gates are implemented; its provisioning is not.**
`createTestHarness({ lane: "ephemeral-camp", yard })` really does require an
explicit Yard and a brokered credential locator in
`HOBO_TESTING_CAMP_CREDENTIAL_REF`, and refuses each missing piece with its own
code. `deploy()` then refuses with `HARNESS_LANE_UNIMPLEMENTED`. It never
degrades to `in-process`: a suite that believes it hit real providers and
actually hit a loopback stub is worse than a suite that failed.

**`prodReadinessClaimable` is not a pass/fail flag.** It is always false for
the current in-process lane. Accessing a handle does not prove that a test
asserted anything or that a deployed provider behaves the same way.
`assertedAgainst` is the historical field name for handles reached during the
run; it is access telemetry, not a record of completed assertions.
An unresolved, mocked, or camp-only dependency makes dependent handles
`mocked`, except that camp-only resources retain their own label. Calling
`outputs()` records access to every returned resource.

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

## Local services and swappable ports

`graph.queue(alias)` returns the same `@hobo/core` `Queue` interface a
service can receive in a deployed runtime; `graph.topic(alias)` returns the
`Messaging` interface; `graph.secret(alias)` returns the existing
`@hobo/identity` `SecretsPort`; `graph.data(alias)` returns the
`@hobo/data-core` engine SPI backed by an isolated in-memory SQLite engine.
`graph.schedule(alias)` returns the existing `@hobo/core` `SchedulerPort`.
`graph.kv(alias)` and `graph.bucket(alias)` expose the generated interfaces for
HoBo's pinned WASI key-value and blobstore subsets.
`graph.flag(alias)` exposes the identity package's `FeatureFlagPort`, backed by
a fresh local flag engine. The HoBo feature command accepts the same port.
Use `createFlagEmulator({ now })` to control event timestamps; every evaluation
is recorded by default, and `sampleRate` can be overridden. The optional
`flagInspector(alias)` exposes a copy of the test event history separately from
the service port.
`graph.experiment(alias)` and `graph.rollout(alias)` expose the identity
package's `ExperimentPort` and `DeliveryPort`. If the resource declares one flag
dependency, the default engine uses that flag port and inherits its fidelity.
With no flag dependency it owns an isolated store; multiple flag dependencies
require an explicit emulator factory. A served application must receive the
port through its own dependency injection; the graph does not inject service
ports through the Bindle runtime context.

`createExperimentEmulator({ store })` and `createDeliveryEmulator({ store })`
accept a shared `FeatureFlagPort` and an optional `now` clock. A supplied store
is treated as `mocked` unless its fidelity is explicitly supplied as
`storeFidelity`. Create a fresh shared store for each deployment.
Inject the appropriate port into the service under test and use
the same object to arrange inputs and inspect results. The included CI relay
test in [`packages/hobo/test/service-emulators.test.ts`](../hobo/test/service-emulators.test.ts)
passes a signed webhook through the real relay handler to a queue-backed test
application, including a duplicate delivery. That application is in-memory:
the test does not prove the relay's durable admission requirement.

```ts
import { parseIdempotencyKey, parseQueueName } from "@hobo/core";

const graph = await harness.deploy(app)();
const queue = graph.queue("jobs");
await queue.enqueue(parseQueueName("jobs"), { id: 1 }, {
	idempotencyKey: parseIdempotencyKey("job-1"),
});
await workerThatAcceptsAQueuePort(queue);
// If the implementation supplies a virtual clock, advance without sleeping:
graph.queueClock("jobs")?.advance(30_000);
```

For a graph with a `flag` resource named `features`, a test can arrange a
flag and exercise the same port the application receives:

```ts
const flags = graph.flag("features");
flags.define({ key: "checkout", percentage: 100 });
const result = flags.evaluateBoolean("checkout", { targetingKey: "user:alice" });
expect(result.value).toBe(true);
```

For a service that needs its dependency during construction, create the
emulator first, pass `emulator.port` into the service, and return that same
emulator from the matching factory. Create a fresh emulator and harness per
test graph so state is not shared between suites.

Queue resources use `createRuntimeLocalQueueClock`; the returned clock drives
lease expiration and redelivery. Topic resources use `createInMemoryMessaging`
with tenant `local`; use `createTopicEmulator({ tenantId, now })` to control
tenant and time. With the defaults, each resource and deployment gets separate state. Unsupported
aliases and wrong kinds fail with a typed refusal. Factories can replace the
defaults, for example to inject a faulting implementation of the same port:

```ts
const harness = createTestHarness({
	emulators: {
		queue: ({ alias, stage }) => {
			const testQueue = makeTestQueue({ alias, stage });
			return { port: testQueue.port, fidelity: "mocked", close: () => testQueue.close() };
		},
	},
});
```

Queue, topic, secret, data, schedule, key-value, bucket, flag, experiment and rollout factories return `ServiceEmulator<T>`: a typed port, a
`simulated` or `mocked` fidelity label, and an optional `close`. Queue
and schedule emulators may also expose a `VirtualClock`; data emulators require `close`.
The scheduler supports interval schedules only: `graph.scheduleClock(alias)`
advances virtual time and returns fired timers, but does not run a job handler
automatically. Cron expressions and deployed scheduler behavior are not emulated.
The SQLite data port supports the engine's declared dataset, record, and
other SPI operations, but it is not a remote database connection, a SQL client,
or a substitute for provider-specific query semantics. In-memory SQLite does
not expose the schema migration port. A factory runs once per alias;
it must create isolated state and clean up any resources it creates before
throwing. On a later startup failure, the harness closes previously returned
services in reverse dependency order. Teardown attempts every close, reports
errors, and is idempotent. The built-in memory ports retain their state while
the test keeps a reference to them; discard those references after teardown.
Invalid factories are refused rather than replaced with defaults. The harness
checks the port's shape and label, not its semantics: an author who labels a
custom implementation `simulated` is
responsible for its conformance. These factories are for test implementations;
the in-process lane does not attest a real provider.

The pinned blobstore interface returns object metadata but defines no body-read
operation. The optional `bucketInspector` exposes `readBody(name)` as a
test-only inspection capability, separate from the generated port. Storage
values and inspected bodies are copied at the boundary. A replacement bucket
factory may omit the inspector.

### Choosing and maintaining a double

Use the smallest double that exercises an actual boundary. Pure functions and
in-process libraries can normally run directly. A fake per package would
otherwise duplicate code without testing a service contract.

| Boundary | Existing local option | Limit |
|---|---|---|
| HoBo HTTP service | Run its Fetch handler in the harness; use a Pact-derived mock when the consumer needs isolation | Only handlers explicitly provided to a Bindle are served |
| HoBo CI relay | `createRelayHandler` with an injected application, as in the service emulator test | A memory-backed application does not prove durable admission |
| HoBo CI pipeline backend | `@hobo/ci/testing` `createScriptedPipelineBackend()` supplies the shared `PipelineBackend` interface | Mocked, scripted results; it executes no commands and does not verify provider behavior or billing finality |
| HoBo control API | `createControlApiServer` with a temporary `hoboHome`; optional seeded `@hobo/yard-world` demo | Runs the actual local service and simulator, not a deployed Station |
| HoBo CD notifications | `@hobo/cd/boundary` notification port with an `@hobo/cd/testing` recording CDEvents sink | Exercises CD's local event construction; no webhook or provider behavior |
| Queue / topic | This harness's `Queue` / `Messaging` port implementations | In-memory, process-local, not a provider protocol or a durability proof |
| Secrets | `graph.secret(alias)` and `createSecretEmulator()` wrap the identity package's in-memory `SecretsPort` | Test material lives in process memory; use fixture values, not real credentials |
| Data engine | `graph.data(alias)` and `createDataEmulator()` use SQLite through the shared engine SPI; the emulator runs its conformance suite | Process-local SQLite, no raw SQL or remote database protocol; no schema migration port in memory |
| Schedule | `graph.schedule(alias)` uses the scheduler port; `graph.scheduleDriver(alias)` registers handlers and advances virtual time | Interval schedules only; the raw clock does not invoke handlers and graph edges are not wired automatically |
| Key-value / blob metadata | `graph.kv(alias)` and `graph.bucket(alias)` implement generated types from the pinned WASI subsets | Process-local; the pinned blob interface has no body-read operation and does not claim a complete WASI or cloud storage implementation |
| Flags | `graph.flag(alias)` or `createFlagEmulator()` supplies an isolated `FeatureFlagPort` | In-process flag engine; not a remote provider or a complete WIT implementation |
| Experiments / rollout | `graph.experiment(alias)` and `graph.rollout(alias)` expose identity ports linked to a declared flag dependency | In-process engines; application ports require explicit injection and no remote provider is emulated |
| Loss-tolerant cache | `@hobo/kv-redis-compatible` `createMemoryEphemeralState`, with its manual clock | TTL-bound `EphemeralStatePort`, not a general `kv` resource; it is not automatically wired into this graph |
| Durable event store | `@hobo/runtime-local` / `@hobo/storage-sqlite` | Requires the real SQLite runtime; not a fake of a remote database |
| Vercel Blob | `@hobo/provider-vercel-blob` memory SDK and package-local HTTP emulator | Implements the documented subset used by that provider, not all of Vercel |
| AWS resolvers | `@hobo/provider-aws` has an opt-in [AWS Emulator lane](../providers/provider-aws/README.md#aws-emulator-lane) | Requires the local emulator; supported APIs are limited and a pass does not verify live IAM |
| Vercel project resolver | `@hobo/provider-vercel` uses [Vercel Labs' in-process emulator](../providers/provider-vercel/README.md#local-vercel-api-emulation) | Covers a project API subset, not deployed execution or all creation paths |
| Azure ARM resolvers | `@hobo/provider-azure` tests inject a stateful fake `HttpTransport` | Models selected ARM interactions, not a complete Azure emulator or live provider |
| External HTTP provider | `@hobo/contract-harness` `createMockProviderFromPact`; `@hobo/testing` `pactBackedTransport` for stateful sequences | Hand-authored or unverified Pact expectations are not evidence about the live provider |
| Other resource kinds | Provider-specific doubles and external emulators where available | The application harness currently exposes only placeholders for those kinds |

### Resource catalog coverage

This inventory follows the Bindle resource catalog. `port` exposes a local port;
`http` serves a supplied Fetch handler; `fixture` names a separate local fixture;
`placeholder` has no graph emulator; `camp-only` needs a different lane. A
fixture or placeholder remains `mocked` in the graph, and an HTTP resource is
`mocked` until it has a served handler.

<!-- resource-emulation-inventory -->
| Kind | Graph support | Scope and next choice |
|---|---|---|
| `api` | `http` | Serve an explicitly supplied Fetch handler |
| `kv` | `port` | Pinned WASI key-value subset; process-local bytes |
| `bucket` | `port` | Pinned blob metadata subset; body inspection is test-only; no blob events |
| `queue` | `port` | HoBo Queue and virtual clock; no provider protocol or durability |
| `topic` | `port` | HoBo Messaging; no external broker |
| `secret` | `port` | Identity SecretsPort with fixture material only |
| `data` | `port` | SQLite data-engine SPI, not raw SQL or provider query semantics |
| `schedule` | `port` | Interval fires and explicitly registered handlers; no cron expressions or automatic graph wiring |
| `project` | `placeholder` | Placement metadata; no service port in the graph |
| `websocket` | `placeholder` | Use a protocol-specific test server until a shared port exists |
| `job` | `placeholder` | Use a real local worker or a contract double for its boundary |
| `web` | `http` | Serve an explicitly supplied Fetch handler |
| `service` | `http` | Serve an explicitly supplied Fetch handler |
| `external` | `placeholder` | Use a verified Pact-derived mock or a provider emulator |
| `container` | `camp-only` | Requires a container-capable environment |
| `wasm-component` | `camp-only` | Requires a host that executes component bytes |
| `flag` | `port` | Identity's local FeatureFlagPort; not a remote provider |
| `auth` | `placeholder` | IdentityService can test workload identity; it is not a full auth/session emulator |
| `crypto` | `placeholder` | The in-memory KMS supports identity signing, not the whole crypto catalog |
| `notify` | `placeholder` | CD's NotificationPort has a recording sink; it is not the catalog's general notify port |
| `guardrail` | `placeholder` | Use the relevant policy implementation or a contract double |
| `ui` | `http` | Fetch handlers only; no general UI render/drive port |
| `experiment` | `port` | Local ExperimentPort; uses one declared flag dependency when present |
| `rollout` | `port` | Local DeliveryPort; uses one declared flag dependency when present |
<!-- /resource-emulation-inventory -->

Keep the port or protocol as the authority: derive stateless mocks from the
consumer Pact instead of copying response shapes, keep fixtures versioned,
and verify provider interactions and the same behavioral conformance suite
against both the double and a real implementation when practical. Record
unsupported calls, capabilities, clocks, failures and fidelity. Add a stateful
emulator only when sequences matter, and keep its scope narrower than the
service it imitates. A green fake or local emulator is not live-provider
verification.

The optional schedule driver builds on the local scheduler's `registerJob` and
`advance` methods:

```ts
import { parseIdempotencyKey, parseQueueName, parseScheduleId } from "@hobo/core";

const alias = "nightly";
const driver = graph.scheduleDriver(alias);
if (!driver) throw new Error(`No schedule driver for ${alias}`);
const queue = graph.queue("inbox");
driver.registerJob(parseScheduleId("repair"), { everyMs: 1_000 }, async (fire) => {
  await queue.enqueue(parseQueueName("inbox"), { occurrence: fire.occurrence }, {
    idempotencyKey: parseIdempotencyKey(JSON.stringify([alias, fire.fireId])),
  });
});
await driver.advance(3_000);
```

Register a handler explicitly for each interval schedule. The built-in driver
deduplicates schedules by ID, including schedules created through the shared
port or raw clock. Re-registering an ID keeps its original interval and start
time even if the new spec differs, but replaces any prior handler. The returned
schedule has `deduped: true` and reports the actual interval and next fire time.
The replacement handler receives fires collected after registration; a batch
already collected retains its earlier handler.

Advancing the driver
awaits handlers in fire order and reports failures after running the other due
handlers. For the built-in driver, the `AggregateError` contains a
`ScheduleHandlerError` for each failed fire; its `fire` identifies the schedule
and occurrence, and its `cause` retains the original thrown value. When handlers
fail, the rejected advance keeps the elapsed virtual time and their side effects,
including effects performed before a failure; those fires are not retried
automatically.
The clock reaches the requested target before handlers run, so each handler
observes that target time rather than its own fire time. Driver advances run in
call order. An advance starts asynchronously, so synchronous registrations made
before it starts can fire during that advance.
Each advance collects its due fires before running handlers. Timers or schedules
registered during a handler wait for the next advance, even if already due.

For the built-in driver, teardown waits for the active advance and refuses
queued work. A handler invoked through the graph's driver cannot destroy its
own graph. A factory cannot destroy the graph while its own deployment is in
progress. Detached tasks started by a handler are not tracked.
`scheduleClock(alias).advance` consumes raw clock fires without running their
handlers; later driver advances do not deliver those fires. The raw clock
refuses to advance while a driver advance is queued. Fire IDs are unique within
a clock, so include the schedule resource alias when using one as an idempotency
key across resources, as in the example. Include a graph or deployment namespace
too when sharing a destination across deployments. The driver does not automatically
retry failed work, parse cron expressions, wire graph dependencies or model
provider delivery guarantees. A custom schedule emulator may omit the driver.
Declare dependencies on resources a handler uses so graph teardown keeps them
alive until that handler finishes.

## Surface

- `createTestHarness(options?)` → `{ deploy, destroy, untilReady }`.
  `deploy(bindle)` and `destroy(bindle)` return **thunks**, so they drop
  straight into `beforeAll`/`afterAll`.
- `DeployedGraph` → `outputs()`, `resource(alias)`, `http(alias)`,
  `queue(alias)`, `queueClock(alias)`, `topic(alias)`, `secret(alias)`, `data(alias)`,
  `schedule(alias)`, `scheduleClock(alias)`, `scheduleDriver(alias)`, `kv(alias)`, `bucket(alias)`,
  `bucketInspector(alias)`, `flag(alias)`, `flagInspector(alias)`, `experiment(alias)`,
  `rollout(alias)`, `fidelity()`.
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
`prod_readiness_claimable` remains false without runner-backed assertion and
deployment evidence).

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
- `contracts/pacts/service-emulators.pact.json` — queue/topic/secret access,
  delivery and wrong-kind refusal; verified by
  `test/service-emulators.pact.test.ts` against the harness. Existing
  queue/clock protobuf, CUE, and PACT contracts live with `@hobo/core` and
  `@hobo/runtime-local`; `@hobo/conformance` provides the Messaging suite.
  No new serialized port records or event families are introduced here. The
  harness refusal CUE is updated for the two new error codes and checked for
  vocabulary drift by `test/refusal-contract.test.ts`. TypeScript checks the
  port substitutions at build time.
