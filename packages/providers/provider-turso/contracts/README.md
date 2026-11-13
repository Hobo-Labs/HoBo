# Contracts

One boundary crosses out of this package: the binding's statements to a libSQL
database through `@libsql/client`'s `execute`.

## `libsql-ephemeral-state.pact.json` — the statement contract

`@hobo/provider-turso`'s `EphemeralStatePort` binding is the **consumer**; a
libSQL database reached through `@libsql/client` — Turso or `sqld` over HTTP,
or a local `file:` database — is the **provider**.

Each interaction is one statement: its SQL text, its positional arguments, and
the rows the database returns. Values are written in Hrana's typed form, the
protocol `@libsql/client/http` speaks to Turso: `integer` as a decimal string,
`text`, `blob` as base64, `null`. That makes two load-bearing details visible:

- **The SQL text is the atomicity argument.** Every conditional write carries
  its condition in the statement's `WHERE` clause and reports through
  `RETURNING`; editing a statement changes the pact, deliberately.
- **Integers are bound as integers.** A TTL, a revision or a counter step bound
  as a float would make SQLite store `10.0`; the pact shows `integer`.

The clock argument is bound to a fixed instant and incarnations are fixed, so
every reply is reproducible. In production the clock argument is `null` and the
database's own clock (`julianday('now')`) is used.

`test/statement-pact.test.ts` replays both sides: the consumer side drives the
binding through the port against a replaying client and asserts it sends
exactly these statements and turns these rows into the expected results; the
provider side runs every statement against a real `file:` database and
compares the rows.

**Not pinned here:** the Hrana-over-HTTP envelope (pipeline requests, the
version probe, the bearer header) belongs to `@libsql/client`, which this
package pins to an exact version. `test/turso-env.test.ts` checks only that the
client sends HTTPS with the token as a bearer header. Nothing here has been
replayed against Turso itself.
