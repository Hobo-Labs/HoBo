# `@hobo/runtime-browser`

Browser-hosted SQLite EventStore / runtime journal adapter.

## Design

- SQLite WASM runs in a **dedicated module Worker** (never on the UI thread).
- Default durable mode uses **OPFS + `opfs-sahpool`** for single-owner partitions.
- OPFS absence: explicit `PersistenceUnavailableError` when durable mode is
  required; optional transient in-memory mode when the caller opts in.
- Does **not** copy native `journal_mode=WAL` blindly; journal/locking follows
  the selected OPFS VFS constraints.
- Shared schema/migration/commit semantics live in `@hobo/storage-sqlite`.

## Dependency

Optional peer: `@sqlite.org/sqlite-wasm` (Apache-2.0; license-gated).

**Honesty rule:** `persistenceMode: "opfs-sahpool"` is only returned after a real
OPFS-backed journal open. When OPFS/WASM cannot open and `allowTransient` is
false, the factory throws `PersistenceUnavailableError` — it never pretends
memory is durable. Unit tests use `allowTransient: true` for semantic coverage.

## Support matrix

| Capability | Behavior |
|---|---|
| OPFS + Worker | Durable default (`opfs-sahpool`) |
| No OPFS, `allowTransient` | In-memory partition (lost on reload) |
| No OPFS, durable required | `PERSISTENCE_UNAVAILABLE` |
| Multi-tab concurrent writers | Not default; explicit multi-tab mode only |
| SharedArrayBuffer / COOP/COEP | Not required for default sahpool path |

## Architecture rules

Parse, don't validate: storage RPC frames from the OPFS worker are parsed once
into derived types (`BrowserStorageRpcRequest`/`Response`, persistence status)
before the event store consumes them; invalid frames are unrepresentable past
the boundary.

Event architecture: the browser event store accepts append commands, emits
events through the storage actor, and serves reads from projections over
materialized views; current state is cached in snapshots and historical
snapshots persist in the OPFS read store when a real OPFS backend is
available (the runtime fails closed otherwise).
