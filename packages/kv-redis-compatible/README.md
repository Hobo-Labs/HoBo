# `@hobo/kv-redis-compatible`

Provider-neutral authoring and conformance for Redis-compatible key/value
storage.

This package names no product. It contains no provider identifier, imports no
provider package, and nothing in its public API lets a caller express a
preference for one. A Bindle asks for `kv.redis-compatible/v1` semantics;
Matching decides who serves it.

## What it gives you

### Authoring

```ts
import { redisCompatible, valkey } from "@hobo/kv-redis-compatible";

const cache = redisCompatible.store({
  ttl: true,
  atomicIncrement: true,
  minValueBytes: 64 * 1024,
});

const valkeyStore = valkey.store({ sortedSets: true });
```

Both return a parsed `CapabilityRequirement` from `@hobo/capability-profiles`.
`redisCompatible.store()` targets `kv.redis-compatible/v1`; `valkey.store()`
targets its `kv.valkey/v1` refinement. Both always demand the
`redisCommandSemantics` guarantee, so a product that exposes GET and SET over
HTTP and calls it Redis does not qualify.

An explicit `false` means "do not care", not "must not have". A prohibition
would rule out a perfectly good store that happens to support more than you
asked for.

### Conformance

The suite is data. A case is a list of command templates and expectations; the
thing that talks to a store is injected:

```ts
import { runKvRedisConformance, toProfileImplementations } from "@hobo/kv-redis-compatible";

const report = await runKvRedisConformance({
  executor,                       // your KvRedisExecutor
  transport: "rest",              // "rest" | "resp" | "in-process"
  limits: { maxValueBytes: 1_048_576 },
  keyPrefix: "run-42:",           // keeps a live run off application keys
});

const implementations = toProfileImplementations(report, { conformanceRef });
```

Twenty cases across six areas: `transport`, `key-value`, `ttl`, `atomicity`,
`bounded-payload`, and `consistency`. The scope is deliberately closed —
command transport, the key/value data types, expiry, the atomic operations the
profile promises, behaviour at a declared payload bound, and the consistency a
single client can actually observe.

Three rules keep a report from over-claiming:

1. **A case that could not run is `skipped`, never `pass`.** No time control
   means the expiry case is skipped rather than assumed. No declared value-size
   limit means the bounded-payload cases are skipped rather than invented.
2. **A run with any skipped required case is `incomplete`,** and `incomplete`
   projects to `conformance: "unknown"`, which selection fails closed on.
3. **A capability is substantiated only when every case that substantiates it
   passed.** One of two is not evidence.

`restTransport` is the one capability the cases cannot establish, because it is
a property of how the run reached the store rather than of any command. The
runner adds it only when `transport: "rest"`.

### Consistency, honestly

`KV_REDIS_CONSISTENCY_CLAIMS` records what the suite asserts *and what it
refuses to*:

| Property | Asserted | Why |
|---|---|---|
| `readYourWrites` | yes | `consistency.read-your-writes` |
| `monotonicSequentialWrites` | yes | `consistency.monotonic-counter-in-session` |
| `linearizableAcrossClients` | **no** | needs concurrent clients and a real-time ordering oracle |
| `durableAcrossFailover` | **no** | needs an induced node failure |
| `crossRegionReplicationBound` | **no** | a deployment property, not a Redis semantic |

A provider that copies this list without adding its own evidence inherits the
`no` rows too.

### Redis data structures are not delivery guarantees

Redis has lists, streams, and pub/sub. None of them is a queue or a topic:

- `LPUSH`/`RPOP` has no acknowledgement, no redelivery, no visibility timeout,
  and no dead-letter path. A consumer that dies after `RPOP` has silently
  dropped the message — exactly what `queue.at-least-once/v1` exists to rule out.
- Redis pub/sub reaches whoever is connected at publish time and retains
  nothing, so it is `topic.ephemeral-pubsub/v1` at best and never
  `topic.durable-log/v1`.
- Streams are closer, but consumer groups, offsets, and retention are their own
  semantics with their own failure modes and their own conformance.

`KV_REDIS_NON_IMPLIED_PROFILES` names the four profiles this package explicitly
does not imply, `explainNonImplication` says why for each, and
`assertNoQueueTopicImplication` is the parse-boundary guard a provider calls on
its own declaration at module load.

The guard checks the *conformance reference*, not the profile list. A product
implementing both a store and a queue is legitimate; one conformance run
standing behind both is not.

`test/separation.test.ts` drives `selectCapabilityImplementation` with a
reference candidate that advertises the whole Redis data-type surface and shows
it is rejected with `PROFILE_INCOMPATIBLE` for `queue.at-least-once/v1`,
`queue.fifo/v1`, `topic.pubsub/v1`, `topic.durable-log/v1`, and
`topic.ephemeral-pubsub/v1`.

## Ephemeral state: a TTL + CAS port on any Redis-protocol store

`EphemeralStatePort` (the interface lives in `@hobo/core`,
`src/ports/ephemeral-state.ts`) is the port for state a service may lose:
lease records, job-taken markers, dedupe keys, rate counters, scanner locks,
small in-flight indexes, and a capped change feed. Every write carries a TTL;
whatever is read must be rebuildable from an authoritative source. This
package holds the one Redis-protocol implementation of it, its in-memory
engine, its conformance suite, a RESP/TCP executor, and a command meter.

```ts
import { createRedisEphemeralState, meterExecutor } from "@hobo/kv-redis-compatible";
import { createRespExecutor, resolveRedisProtocolEnv } from "@hobo/kv-redis-compatible/resp";
import { acquireEphemeralLock, createEphemeralRing, parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";

const bound = resolveRedisProtocolEnv(process.env); // VALKEY_URL, then REDIS_URL
const executor = meterExecutor(createRespExecutor({ url: bound.url }), {
  onCommand: (verb) => metrics.count("cache.command", { verb }),
});
const state = createRedisEphemeralState({ executor });

const lease = await acquireEphemeralLock(state, parseEphemeralKey("lock:scanner"), ownerId, parseEphemeralTtlMs(30_000));
const feed = createEphemeralRing(state, { name: "mcp-changes", capacity: 500, ttlMs: parseEphemeralTtlMs(3_600_000) });
```

### The port

| Method | Semantics | Commands |
|---|---|---|
| `get(key)` | `{ value, version }` or `undefined` | 1 (`HMGET`) |
| `getMany(keys)` | index-aligned `get` | 1 (`EVALSHA`) |
| `putIfAbsent(key, value, ttlMs)` | create unless live; one racer wins | 1 |
| `compareAndSet(key, version, value, ttlMs)` | replace iff the version matches; resets the TTL | 1 |
| `delete(key, version?)` | unconditional, or iff the version matches | 1 (`DEL` / `EVALSHA`) |
| `increment(key, by, ttlMs, mode?)` | atomic; TTL on create (`on-create`) or on every call (`refresh`); refuses a non-integer value | 1 |
| `expire(key, ttlMs)` | reset the TTL of a live key | 1 (`PEXPIRE`) |
| `acquireEphemeralLock` / `renewEphemeralLock` / `releaseEphemeralLock` | `putIfAbsent` / `compareAndSet` / versioned `delete`; only the current lease renews or releases | 1 each |
| `createEphemeralRing(...).append(value)` | `increment(seq, refresh)` + `putIfAbsent(entry)` + `delete(evicted)` | 3 (2 until full) |
| `createEphemeralRing(...).read(afterSeq, limit?)` | `get(seq)` + `getMany(window)`; reports `gaps` and `reset` | 2 (1 when empty) |

The table is `EPHEMERAL_STATE_COMMAND_COST` in `@hobo/core`, and the
conformance case `cost.matches-documented-command-cost` asserts it against the
meter on every binding. A script's *first* use against a server whose script
cache lacks it costs one more command (`EVALSHA` answers `NOSCRIPT`, then
`EVAL`); a restart or `SCRIPT FLUSH` pays that again. At these costs a relay
doing 1,000 job leases a day (acquire, renew, release, and one feed append
each: 6 commands) spends about 180K commands a month.

**Versions** are opaque `<incarnation>:<revision>` tokens. The incarnation is
a random token chosen by the write that creates the key, so a version from a
deleted or expired incarnation never matches the recreated key (no ABA).

**The ring** keeps `ring:{<name>}:seq` and `ring:{<name>}:e:<seq>`. The braces
are a cluster hash tag, so a clustered Valkey keeps a ring in one slot. The
counter's TTL is refreshed on each append, so it outlives every entry; an idle
ring expires whole and restarts at 1, and a cursor past the head reads
`reset: true` instead of waiting forever. A sequence allocated by a writer that
died before its entry write is reported as a `gap`, never reordered.

### One implementation, three executors

Every conditional write is a Lua script (`src/ephemeral-scripts.ts`) over a
hash `{v, i, r}`, sent as `EVALSHA` with an `EVAL` fallback. The scripts use
plain Redis 5+ commands only, so they run identically on:

| Binding | Executor | Where it lives |
|---|---|---|
| In-memory (tests) | `createMemoryRedisExecutor({ now })`: the scripts' semantics in TypeScript, with a server-like script cache | `src/ephemeral-memory.ts`; `createMemoryEphemeralState` wraps it |
| Valkey / Redis over TCP | `createRespExecutor({ url })` on `ioredis` (pure JavaScript, no native addon) | `@hobo/kv-redis-compatible/resp`, a separate entry point so REST-only bundles never load a socket client |
| A REST-fronted store | that provider's executor | its provider package; this package imports none |

**Binding a self-hosted Valkey.** A caller depends on `EphemeralStatePort`
only, and a composition root picks the executor from configuration:
`resolveRedisProtocolEnv` reads `VALKEY_URL`, then `REDIS_URL` (`redis://` or
`rediss://`, password in the URL), and `createRespEphemeralState` binds it.
Nothing above the executor changes, so moving a caller from a hosted REST
store to a Valkey on a box is a configuration change, not a code change.
Valkey needs nothing beyond `requirepass`; the scripts use no command newer
than Redis 5. The relay's selection order and the hosted environment names are
in [`docs/design/relay-ephemeral-state.md`](../../docs/design/relay-ephemeral-state.md).

### Metering

`meterExecutor(executor, { onCommand })` counts what is actually sent, by
verb, `NOSCRIPT` fallbacks included; arguments never reach it.
`commandBudgetStatus({ used, allowance, elapsedFraction })` projects a
period's usage against an allowance (for example a hosted store's free monthly
command allowance) so the relay can log or alarm before it runs out.

### Conformance

`EPHEMERAL_STATE_CONFORMANCE_CASES` holds 24 cases across key-value,
versioning, concurrency (32-way `putIfAbsent` races, CAS conflicts, an
8-writer CAS loop that must lose no update, 50 concurrent increments), TTL,
counters, locks, rings, and command cost. A lane supplies several clients of
one backend, time control, a meter, and a unit TTL; there is no skip path
inside the suite. Lanes:

| Lane | Where | Runs |
|---|---|---|
| In-memory engine, manual clock | `test/ephemeral-state.test.ts` | always |
| Real Valkey/Redis over RESP, real sleeps | `test/ephemeral-resp.test.ts` | when `HOBO_VALKEY_SERVER_BIN`, `valkey-server`, or `redis-server` is available (the binary-on-PATH convention the NATS mesh test uses) |
| A provider's REST adapter, local HTTP server, in-memory engine or real server | the provider package's tests | in-memory always; real server as above |

The RESP lane also checks every script's SHA-1 with `SCRIPT LOAD`, replays the
executor pact, and runs the command-level `kv.redis-compatible` suite. A
deliberately broken binding (last-writer-wins `compareAndSet`) is shown to
fail the suite.

**What it does not prove.** Nothing here runs against a hosted store; the
REST lanes prove the adapter, the envelope, and the scripts. Linearizability across
clients is exercised by races on one server, not by a real-time ordering
oracle, and nothing is claimed about durability: the port promises none.

### Contract

`contracts/pacts/ephemeral-state-executor.pact.json` pins the commands the
binding sends (script bodies and SHA-1s included: an edited script is a new
script every server must load) and the replies a store must give, starting
from an empty script cache. `test/ephemeral-pact.test.ts` replays the consumer
side against the binding and the provider side against the in-memory engine;
the RESP lane replays the provider side against a real server. The records are
`EphemeralEntry`, `EphemeralLockLease`, `EphemeralRingEntry`,
`EphemeralRingRead`, `EphemeralCommandCost`, and `EphemeralCommandUsage` in
`@hobo/core`'s `data-models/ephemeral_state.proto`, constrained by
`ephemeral_state.cue`.

## The reference store

`createReferenceRedisStore()` is a deterministic in-memory implementation of
exactly the semantics the suite asserts. Time is arithmetic rather than sleep,
so the expiry case is exact rather than flaky.

It is not a Redis, and it is not here to be one. It exists for two jobs:

- The suite is run against it both intact and deliberately broken
  (`breakVerb`), because a conformance suite nobody has run against a
  known-good implementation is a suite whose passing result means nothing.
- An adapter author can point a REST or RESP transport at it and run the whole
  suite through their adapter, offline. That proves the *adapter* — envelope
  encoding, argument round-tripping, error mapping — without anyone's staging
  cluster. It proves nothing about the real server behind that adapter.

## Parse, don't validate

Every input crosses one parse boundary and becomes a derived domain type the
rest of the package accepts without re-checking:

| Raw input | Parser | Derived type | Impossible afterwards |
|---|---|---|---|
| store options | `redisCompatible.store`, `valkey.store` | a parsed `CapabilityRequirement` | an ask that omits `redisCommandSemantics` |
| a declared limit | `resolveFillSizes` | `FillSizes` | a bounded-payload case running against an invented bound |
| a command template | `resolveCommand` | `RedisCommand` (verb plus resolved arguments) | an unresolved `fill` placeholder reaching an executor |
| an executor reply | `evaluateExpectation` | a `StepResult` | a thrown exception being read as "the store rejected it" |
| a provider declaration | `assertNoQueueTopicImplication` | a checked declaration | one conformance reference standing behind a store *and* a queue |

`runKvRedisConformance` takes the parsed command, never the template, which is
why there is no code path that forgets to apply the key prefix and no code path
that applies it twice.

The protobuf records in `data-models/kv_redis_conformance.proto` are the wire
projection of these parsed types, and `kv_redis_conformance.cue` carries the
invariants that keep a report from over-claiming: a skipped case records no
steps, a passing case cannot contain a failing step, any failed case forces
`fail`, and any skip without a failure forces `incomplete`.

## Event architecture

The suite is pure data and the runner performs no I/O beyond the injected
executor, so nothing here appends anything. A run becomes durable through the
control plane:

- **Commands** — `RunKvConformance` carries the suite reference, the transport,
  and the declared limits; the resulting `ConformanceReport` is what a
  `RecordProvisionedSubject` or `RotateCapabilityBinding` command in
  `@hobo/claims` can then cite as evidence for a `kv.redis-compatible/v1`
  resource.
- **Events** — the coordinator **actor** (`reduce` in `@hobo/claims`) emits
  `ProviderSubjectProvisioned`, `OwnershipVerified`, and
  `CapabilityBindingRotated`; the conformance outcome recorded in those bodies is
  exactly this package's `pass` / `fail` / `incomplete`, projected to
  `pass` / `fail` / `unknown`. Event bodies carry the report record, never a
  connection string — the executor holds the credential and the suite never sees
  one.
- **Event store** — the host appends to the durable SQLite-backed **event store**
  under per-stream OCC and a fencing token. The conformance run itself happens
  outside that transaction, keyed by the run's `keyPrefix`, so a retried run
  cannot collide with the keys of the previous one.
- **Projections / materialized views** — the stream folds into the
  **materialized views** selection reads: substantiated capability keys per
  product, and the current outcome per profile claim.
  `toProfileImplementations` is the shape of that view, which is why an
  `incomplete` run fails selection closed instead of ranking lower.
- **Snapshots / read store** — periodic **snapshots** of the resource aggregate
  back the **read store** behind `hobo status`; historical snapshots keep the
  conformance reference a product was selected under auditable after a later run
  changes the current one.

## Testing

```bash
pnpm --filter @hobo/kv-redis-compatible run build
pnpm --filter @hobo/kv-redis-compatible run test
```

Everything runs offline. There is no live lane: the real-server lanes start a
local `valkey-server`/`redis-server` on a free port and are skipped when no
binary is present.

## Layout

| Path | Contents |
|---|---|
| `src/requirement.ts` | `redisCompatible.store`, `valkey.store` |
| `src/protocol.ts` | command/reply model, expectation evaluation, the `KvRedisExecutor` port |
| `src/cases.ts` | the case catalog and the consistency claims |
| `src/runner.ts` | the runner, the report, and the projections into profile implementations |
| `src/separation.ts` | the queue/topic non-implication rules and guard |
| `src/reference-store.ts` | the deterministic reference store adapters validate against |
| `src/ephemeral-state.ts` | `createRedisEphemeralState`: the `EphemeralStatePort` binding over any executor |
| `src/ephemeral-scripts.ts` | the Lua scripts and their SHA-1 handles |
| `src/ephemeral-memory.ts` | the in-memory engine, `createManualClock`, `createMemoryEphemeralState` |
| `src/ephemeral-meter.ts` | `meterExecutor`, `commandBudgetStatus` |
| `src/ephemeral-conformance.ts` | the ephemeral-state conformance cases and runner |
| `src/resp-executor.ts` | the RESP/TCP executor and env resolver (`@hobo/kv-redis-compatible/resp`) |
| `contracts/` | the consumer-driven contract the executor must satisfy, prose in `README.md` and executable in `pacts/kv-redis-executor.pact.json` |
| `data-models/` | protobuf records for the case and report shapes, plus the CUE invariants over them |
