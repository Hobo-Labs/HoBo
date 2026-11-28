# `@hobo/runtime-rivet`

SDK releases stage this package as `@hobo-labs/runtime-rivet`; the workspace
name in the examples is `@hobo/runtime-rivet`.

Optional **Camp runtime** with a HoBo-owned local journal and Rivet-compatible
actor keys. The local host remains an oracle. The separate distributed journal
uses a real RivetKit actor and an asynchronous lease host.

| HoBo contract | Realization |
|---|---|
| `ActorHost` / `defineActor` | Local host + Rivet-compatible compound key |
| Event facts | `hobo_events` + stream-head CAS in local SQLite |
| Durable mailbox | action-first `hobo_inbox` (not raw Rivet queue) |
| Effects | `hobo_outbox` staged with facts; dispatch after commit |

RivetKit, its WASM package, and the Rivet Engine image are pinned to 3.0.0.
`loadRivetkit()` uses dynamic import for ESM and CommonJS hosts. The live tests
exercise the pinned upstream engine separately from the HoBo local host, verify
actor state across an engine restart, and fail if the engine or an actor action
fails. Journal reopen tests cover persisted-state replay and in-flight commands.
They also exercise the distributed journal against the pinned upstream engine,
including lease contention, durable appends, replay, actor sleep and wake.

Register `createRivetDistributedJournalActor(verifier)` in a RivetKit registry,
and pass its client namespace, tenant, Camp and capability issuer to
`createRivetDistributedJournal`. Each operation needs a short-lived signed
capability bound to the actor key, action and exact arguments; the actor checks
it against a host-owned authorization policy before accessing its journal.
Keep the signing key and authority outside the deployed actor.

Lease grants, fences, deduplication identities and facts share one actor-local
SQLite transaction. Pages contain at most 16 events of at most 32 KiB each;
use the first page's `revision` as `throughRevision` for subsequent pages. If
a grant or append returns `OUTCOME_UNKNOWN`, reconcile with the same request
or event ID. The asynchronous lease port fences appends in this journal only:
it cannot fence a separate event store or external effects. The asynchronous
journal does not yet implement the local host's durable inbox and outbox.
The actor rejects a clock earlier than any time it has persisted; lease expiry
also relies on the host's clock not moving backward between observations.

## Fidelity

- `local-sqlite` uses `node:sqlite` for the local HoBo journal.
- `runner`, `serverless`, and `managed` modes are rejected until a Rivet-backed
  implementation of the synchronous `ActorHost` contract exists. Use the
  separate asynchronous Rivet journal for distributed leases and facts; a
  local journal cannot be labeled `rivetkit`.
- The 3.0.0 pin does not migrate data from an existing Rivet 2 engine. An
  operator must establish and verify an upstream migration before upgrading
  an existing deployment.
- Rivet 3 drops Rivet 2's `@secure-exec` isolate family. The local journal
  host runs no Rivet actor code. The live fixture registers its actor action in
  the fixture process and spawns only the engine binary separately (guard bound
  to 127.0.0.1, admin-token auth); that process boundary is not a security
  sandbox. Untrusted actor code requires a real sandbox before executing with
  credentials.
- The live fixture reserves its engine, peer, metrics and HTTP ports, then
  re-reserves a fresh set (up to three attempts) when a reserved port is
  stolen between reservation and bind; any other failure fails the test with
  the captured engine log.
- The Rivet 3.0.0 engine CLI ships platform packages for darwin (arm64, x64)
  and linux (arm64, x64 — static musl binaries that also run on glibc hosts);
  Rivet 2's win32 package has no 3.0.0 successor. `loadRivetkit()` and the
  local-engine live test reject win32 before native-module loading; Windows
  local-engine paths remain unsupported until upstream ships a binary.
- Raw Rivet queue **receive-loss** is not HoBo at-least-once. Inbox rows are authority.

```ts
import { createRivetRuntimeHost } from "@hobo/runtime-rivet";

const bundle = createRivetRuntimeHost({
  tenantId: "acme",
  campId: "prod",
  journalPath: "/var/lib/hobo/rivet.sqlite",
});
const accepted = bundle.actors.accept({
  identity: {
    tenantId: "acme",
    projectId: "shop",
    actorTypeId: "Cart",
    keySegments: ["user-1"],
    schemaVersion: 1,
  },
  commandId: "cmd-1",
  commandType: "addItem",
  payload: { sku: "hat" },
  expectedRevision: 0,
});
```

Choose a persistent journal path to retain state and accepted commands across
restarts. `journalPath: ":memory:"` is available for intentionally volatile
sessions and tests. A runtime journal is bound to its tenant and Camp; opening
it for another scope is rejected. An existing nonempty journal without a scope
must be adopted explicitly with `adoptUnscopedJournal: true` after its owner has
been verified. Adoption preserves its contents and cannot override an existing
scope binding. The runtime also rejects command identities from another tenant;
callers must still authorize actor operations.

## Actor state and leases

The local SQLite actor host stores `ActorHost.state` events in a dedicated journal stream. Handles for the same actor read the same history, including after reopening the database. Lease ownership and its increasing fence token are stored in SQLite; release or expiry allows a new holder, and stale handles cannot append through the actor host. The host uses a 30-second lease by default, with `leaseTtlMs` and `nowMs` options available for its local clock. The state stream is separate from the command inbox stream.

## Event replay

Actor commands append their original payloads so the same fold can rebuild state after a restart. Each command requires its declared `expectedRevision` to match the revision replayed at commit. A stale command receives a durable `failed-terminal` receipt and does not block later commands. The commit receipt is stored with the facts and outbox rows, so a restart can finish a committed command without applying it again.

Older actor journals may contain folded state in event payloads. When the matching committed inbox entry identifies the original command payload and only one interpretation is valid, replay recovers it automatically. If both interpretations are valid but produce different states, replay stops with an ambiguous-payload error. Set `legacyEventPayloads: "command"` when those records are known to contain folded state, or `legacyEventPayloads: "event"` when they are original event payloads. Both `createRivetActorHost` and `createRivetRuntimeHost` accept the option. Folds must be deterministic and free of side effects.

## Outbox delivery

`processNext` accepts an `effects` callback that derives outbox entries from the folded state and event. It must be deterministic and free of side effects. Each entry has a stream-local `effectId`, digest, and JSON payload; reusing an ID with a different digest or payload fails the whole commit.

Call `dispatchRivetOutbox(journal, streamId, deliver)` to deliver pending entries. A successful callback is acknowledged durably; a failed callback leaves its entry pending for retry. Delivery can repeat after a crash or when dispatchers overlap, so destinations should deduplicate by stream and effect ID.

## Non-guarantees

No cross-actor transaction, no global actor SQL, no exactly-once external
effects, no namespace-as-sandbox, no `wait: true` between actors, no Celld
resolver in this package.

## Durable topic client boundary

`createRivetDurableTopicClient` is an HTTP client and codec for an independently
hosted Rivet durable-topic actor. It does not itself provide the actor, select a
pool, establish journal ownership or advertise topic support. Use it only when
the actor implementation and deployment have been separately verified against
the durable messaging contract.

The trusted host must authenticate the exact actor name, full actor key, tenant,
instance, semantic digest, fixed limits and actor capability descriptor before
issuing a metadata grant or credentials. It must pin the actor to its exclusive journal and pool and fence
all old owners, including work that continues after a timeout. The client sends
canonical, sorted JSON, with message bytes encoded as canonical padded base64.
Its authorization callback receives the exact request bytes and scope; the
actor must independently verify a locally held capability covering those facts
before and throughout its transaction. The response callback must authenticate
the exact response bytes and current disclosure authority. The construction matchers can compare a genuine client with its captured actor
identity or with complete host-held options; they do not establish host
authorization, transport provenance or ongoing fencing. A client-side check or
a Rivet namespace token alone cannot establish these properties.

RivetKit 3's dynamic `getOrCreate(...).fetch` can retry a request after an
actor lifecycle error, including a dropped reply. The host must independently
attest that every replay uses the exact same operation envelope, request bytes,
actor key and semantic digest against the same authenticated durable receipt
journal, including across owner transitions. The journal must check an existing
receipt before any new effect and retain it for the operation's full window.
If those guarantees cannot be established, use a host-verified single-dispatch
transport. A namespace token or identical request bytes alone are not proof of
a shared journal or an old-owner fence.

```ts
import {
  createRivetDurableTopicClient,
  createRivetDurableTopicMetadataGrant,
} from "@hobo/runtime-rivet";

// `binding` and `actor` come from the host's verified deployment registry.
const metadataGrant = createRivetDurableTopicMetadataGrant();
const messaging = createRivetDurableTopicClient({
  binding,
  metadataGrant,
  verifyTransport: (claim) => host.verifyTopicTransport(claim),
  authorize: (request) => host.issueTopicCapability(request),
  revalidate: (response) => host.verifyTopicResponse(response),
  fetch: (path, init) => actor.fetch(path, init),
});
// Inspect `messaging.actorCapabilities` before relying on an actor feature.
// Unsupported calls still reach the actor for durable rejection.
// On revocation, revoke the metadata grant and the host's operation authority.
```

The initial topic-log actor reports consumer groups, leases, acknowledgement,
dead-letter handling and legacy WIT as unsupported. `readRetainedLog` exposes
the actor's retained log with explicit cursor and gap results. It does not grant a delivery lease, advance a consumer checkpoint, or
acknowledge a message; applications and hosts must manage those responsibilities
separately. The descriptor may also mark actor capabilities the client does not
itself implement.

Topic subscription creation, consumption and nack may write to a dead-letter
topic; the host must independently resolve and authorize that destination,
including any later expiry transfer. Audit reads disclose metadata for the whole
instance and need whole-instance authorization. A replayed consume receipt may
contain an expired or superseded lease: independently verify current lease and
authority before external effects. Bounded, safely serializable invalid mutations with valid operation envelopes
reach the actor in a reserved invalid envelope with a type-tagged fingerprint,
so it can durably record a rejection without applying the request. The host must
attest that the bound actor checks existing receipts first and rejects the
reserved marker before effects; its semantic digest must cover that rule. The
fallback envelope has no ordinary top-level topic or group: the host authorizer
must decode and authorize the type-tagged snapshot or deny it, never treat
missing scope fields as a wildcard. Unsafe or oversized input, timeouts, lost
replies and contradictory responses return `unknown` for the exact operation. Retry only the same operation against the same verified
journal, or use independently authenticated reconciliation evidence. A missing
receipt or audit event alone does not prove noncommit.

The client caps request bodies at 131,072 bytes, response bodies at 262,144
bytes, and responses at 4,096 chunks. The mandatory transport verifier must bind the exact fetch adapter and actor
scope to independently enforced request and response stream and per-chunk
allocation limits before the HTTP library materializes a
chunk; the client sees a chunk only after it has been allocated. The host must
also bound CPU, memory, and total in-flight work across all client objects and
processes. `maxInFlight` applies to one client object only; a timed-out slot
remains occupied until that client's underlying work and cancellation settle.
A same-thread timer cannot interrupt a synchronous or non-yielding callback, so
untrusted work needs an independent worker or process watchdog. Revoking a
metadata grant is irreversible; each regrant needs a fresh grant and binding,
and revocation must be propagated and fenced across the host fleet.

The partial-topic live smoke test exercises real Rivet calls and receipt replay.
It does not establish process restart, fault placement, ingress limits,
transaction contention or rollback, or fencing of old owners; those require
independent host and runner evidence.

## Retained topic log

The [Rivet topic-log actor guide](./DURABLE-TOPIC-ACTOR.md) describes its
partial capabilities, setup, limits and host obligations.

The separate [durable topic bus guide](./DURABLE-TOPIC-BUS.md) explains group
leases, DLQ capacity reservations and its instance-wide host authorization.

The finite `DurableTopic` model checks reservation, lease, dead-letter and
compaction transitions for two messages, one group and capacities three and
four. Its mutation checks require counterexamples for omitted reservations,
blocked final transfers, stale leases and premature or out-of-order compaction; witness checks
show full-capacity final leases and two dead-letter transfers are reachable.
This is an abstraction, not a refinement proof of the actor. It does not model
cyclic dead-letter chains, multiple groups, audit or sequence exhaustion,
receipt and state-size exhaustion, batch rollback, clocks, authorization,
storage isolation, host fencing or progress under persistent saturation.
Run it from the repository root with
`HOBO_TLA_TOOLS=/path/to/tla2tools-1.7.4.jar node --experimental-strip-types scripts/check-durable-topic-model.ts`;
the checker refuses any jar other than the pinned TLA+ 1.7.4 release digest.

The test-only `durable-topic-conformance` harness adapts host-supplied process,
clock, fault and ownership controls to the generic durable-messaging suite. It
refuses a partial capability descriptor before running the full bus suite.
Passing cases do not establish that those controls really restarted the process,
injected a fault at the claimed point, isolated tenants or fenced older owners:
all such evidence remains unverified until an independent runner attests it.
The host must also fence and drain late opens and fault operations after a test
timeout or teardown.

The SQLite bus fixture runs the generic group isolation, lease receipt replay,
detached request, fingerprint, tenant isolation and bounds cases through the
real bus actor and client. It reports each remaining case as unknown before
dispatch because it lacks the required process/fault controls or configurable
profile. Its in-memory stores and test credentials do not prove deployment
isolation, process recovery or a host fence.

A separate fixture hosts the same actor and client in a child process, checks
that the process exits on termination, and reopens the same SQLite files. It
also drops selected replies only after a committed response. The generic test
reports its supported cases individually and leaves unavailable fault, race and
profile cases unknown. This exercises a local process boundary, not a Rivet
engine crash, production ingress, distributed ownership or independently
verified fault placement.

Synchronous actor and journal authorities must return synchronously. Ordinary native promise rejections are observed and refused. Exotic or proxied promises are refused without reading their thenables or constructors; the caller remains responsible for handling any rejection from an exotic promise.

The Rivet topic actor uses the provider-neutral bounded reducer from
`@hobo/runtime/durable-topic-reducer` with its actor-local transactional journal.

The actor uses the provider-neutral SQLite topic receipt journal from
`@hobo/runtime/durable-topic-journal`.

The bounded topic models and reducer model tests are shared with the
provider-neutral runtime.

The separate-process topic harness exercises paired concurrent publishes,
consumer claims, lease expiry and compaction races at a pre-dispatch barrier.
It does not claim to inject faults inside the SQLite transaction.

The SQLite test harness can deny disclosure after a receipt read or suppress
the read result to exercise recovery and privacy for revoked or unavailable
receipt authority, including through the separate-process harness.
