# Journal event store (L36)

`createJournalEventStore({ servers, credentials })` returns a `FleetEventStore`
on the `FLEET_JOURNAL` stream, the event store of the high-availability
profile (design §6.16). Several authority replicas can share it without a
leader.

## Layout

| What | How |
|---|---|
| Stream | `FLEET_JOURNAL`, subjects `fleet.journal.>`, no expiry, `deny_delete`, `deny_purge`. Created with one replica only if it does not exist; `provisionTopology` normally creates it with the deployment's replica count |
| Subject | `fleet.journal.<token>`: the stream id with every character outside `[A-Za-z0-9_:-]` written as `%XX` per UTF-8 byte, so any stream id is one token and the mapping is reversible |
| Message | One per append: `{ v: 1, ownerEpoch, events }`, the batch's full envelopes and the stream's fencing epoch after the append |
| Compare-and-set | The publish carries `Nats-Expected-Last-Subject-Sequence` set to the stream sequence of the last message this store read on the subject; error 10071 becomes `OptimisticSequenceConflictError` |
| Position | `readAll` positions are `(stream sequence << 20) + place in batch + 1`; at most `2^20 - 2` events per append |

## Rules

The same as `createMemoryEventStore` and the SQLite journal: per-stream
`expectedSeq`; `meta.idempotencyKey` deduplicated per stream, also on a retry
with a stale `expectedSeq` and across replicas; single-writer fencing through
`fenceToken` (the epoch lives in the journal, so every replica enforces it);
`read` and `readAll` parse every envelope and refuse a message filed under
another stream. Before an append the store catches its cache of that stream up
from the journal. `subscribe` delivers what is stored after it was called, in
stream order, through an ordered consumer; an append from the same store waits
until its subscriptions are listening. `snapshot` checks the sequence against
the head and returns the record, as the core port's other stores do.
`getStreamHead` answers the head this store last read or wrote.

`credentials` is the text of a NATS credentials file; empty connects without
authentication (tests only).

## Assumption A15

A15 (`runEventStoreConformance` can host a network store through an adapter
harness) **holds**: `test/journal/harness.ts` adapts the store to the suite's
synchronous factory (every method awaits the opened store; a data directory
names a reopened connection on the same stream; `fold` quarantines as
`@hobo/runtime-local` does; the crash probe closes the connection with batches
in flight). All eight assertions pass against the fake JetStream context in
`journal.test.ts`, and `journal.integration.test.ts` runs the harness and
`runJournalConformance` against `nats-server`. No fallback taken.

## Tests

- `test/journal/journal.test.ts`, `nats.test.ts`: isolated, against a fake
  JetStream context (`fake-jetstream.ts`, `fake-jetstream-client.ts`).
- `test/journal/journal.integration.test.ts` (O11): `nats-server` from
  `HOBO_FLEET_NATS_SERVER_BIN` or `PATH`; fails without it when `CI` is set,
  otherwise reports one `[A15]` skip.
