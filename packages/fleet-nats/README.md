# `@hobo/fleet-nats`

Every NATS interaction of HoBo Fleet (ADR-0182), and the only package that
imports a NATS client. NATS runs in operator mode with an account per tenant;
devices get per-connection user credentials minted by the authority's auth
callout from scoped signing keys whose permission templates are fixed to the
member id; every listener uses TLS. The bus is never trusted: anything that
grants trust is a signed envelope verified against the pinned trust record.

## Entry points

| Entry point | Does |
|---|---|
| `provisionTopology` | Creates a tenant account, its static users, scoped signing keys, streams and buckets |
| `createNatsBusConnector` | Connects a device and returns its `FleetBus` |
| `connectAuthorityBus` | Connects the authority and returns its `AuthorityBus` |
| `startCalloutResponder` | Answers NATS auth callouts with credentials scoped to the member |
| `createJournalEventStore` | A `FleetEventStore` on the `FLEET_JOURNAL` stream (high-availability profile) |
| `createBusRelayTransport` | A `FleetTransport` relayed over `fleet.relay.<to>.<session>` |

Until each lane lands, its entry point has its final signature and throws
`FleetNotImplemented`.

## Gates

- **TypeScript:** `pnpm --filter @hobo/fleet-nats run build`.
- **Protobuf + CUE:** `data-models/fleet_nats.proto` holds this package's local
  connection settings and `fleet_nats.cue` constrains them; the fleet's
  records are `@hobo/fleet`'s. Parse, don't validate: settings and every record
  read from the bus are parsed derived types (`@hobo/fleet` ids and verified
  envelopes); nothing unparsed leaves an adapter.
- **PACT:** `contracts/` (a placeholder until the callout and bus pacts land).
- **Conformance:** the bus passes `runBusConformance` and the journal store
  `runJournalConformance` from `@hobo/fleet/testing`.
- **Integration:** `*.integration.test.ts` run against `nats-server` 2.15.3
  (`HOBO_FLEET_NATS_SERVER_BIN`, or `nats-server` on `PATH`).

## Architecture placement

An adapter package at layer 3. It handles no command of its own: the
authority's commands append `fleet.*` events to the event store, and this
package carries them. The journal event store is one stream on which every
append is one message with `Nats-Expected-Last-Subject-Sequence` as the
compare-and-set. Each device's subscriptions are an actor's mailbox. The
`fleet-registry` and `fleet-views` key-value buckets are the read stores of the
authority's projections (materialized views); they hold no snapshot that is not
rebuilt by replay of the event store.
