# Contracts

One boundary crosses out of this package: an assignment replica's calls to the
store that keeps its log. The SQL replica's statements are pinned where it
lives, in `@hobo/data-postgres`; this package pins the cache replica.

## `ephemeral-assignment-replica.pact.json` — the cache replica's port calls

`ephemeralAssignmentReplica` is the **consumer**; any binding of
`EphemeralStatePort` (`hobo.core.ephemeral-state/v1`: in-memory,
Valkey/Redis over RESP, Upstash REST, libSQL, Vercel Blob) is the
**provider**.

Each interaction is one port call: the operation, the key, the stored value
(a `FleetAssignmentLog` in protobuf JSON, `data-models/backend_fleet.proto`),
the expected version or TTL, and the port's answer. Two details are
load-bearing:

- **Read, check, conditional write.** An `accept` is a `get`, the register's
  rules applied to what it read, and then `putIfAbsent` (no log yet) or
  `compareAndSet` on the version read. That sequence is why two writers
  racing on one backend cannot both extend the log; a duplicate or a gap
  answers after the read with no write at all.
- **The TTL is the port's 30-day cap** on every write and on `refresh`.

`test/replica-pact.test.ts` replays both sides: the consumer side drives the
replica against a port that answers from the pact and asserts it sends
exactly these calls and reaches the expected outcomes; the provider side
runs every call against the in-memory binding with a fixed incarnation and
clock and compares the answers. Each binding's own conformance suite
(`EPHEMERAL_STATE_CONFORMANCE_CASES` in `@hobo/kv-redis-compatible`) is what
makes the other bindings answer the same way; this pact is not replayed
against Upstash, Turso or Blob themselves.
