# Atomic snippets

Git-backed snippet atoms. Each folder is one concept:

- `meta.json` — id, tier, tags, queries, `requires` / `provides`, params
- `body/` — literal `{{param}}` files
- `acceptance.json` — deterministic fill fixture

The catalog loader treats these as first-class patterns: `searchPatterns`
finds them and `renderPattern` fills them with zero LLM calls, like the rest
of the catalog. Applying Yard patterns to the same file merges literal network
and Camp entries, preserves a single provider, and rejects conflicting or dynamic
Yard definitions.

The `http.api.trainable` pattern serves a greeting through Hono and registers a
working trainable baseline; it does not require a generated model to respond.

The `storage.litestream` pattern opens a WAL-mode SQLite database and provides
functions to start continuous Litestream replication, synchronize once, and
restore a replica. Install Litestream 0.5 or later and supervise the returned
child process: starting it does not wait for the first replication, and its
`exit` event reports later failures. Stop the child before running a one-shot
synchronization against the same database.

By default, the replica uses a file URL under `$HOBO_HOME/durable/replicas`
(`~/.hobo` when `HOBO_HOME` is unset). Set `HOBO_LITESTREAM_REPLICA` or pass
`replicaUrl` to select a `file:` or `nats:` target. NATS targets require a
pre-existing JetStream object-store bucket. A configured NATS target never
silently switches to local storage when unavailable. Pass `natsCredentialsFile`
for authenticated NATS connections; credentials embedded in URLs are rejected.
The generated functions pass Litestream a private temporary configuration and
remove it when the process closes. Keep the replica URL for recovery at a
different database path; restore refuses to overwrite an existing database. A
replica can lag the latest SQLite transaction, and writer ownership must be
managed by the application or its host.
