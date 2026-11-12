# `@hobo/fleet-authority`

The HoBo Fleet authority service (ADR-0182): the HTTP API, sign-in providers,
the composition of the recorder and registry projection, operations (key
ceremony, rotation, backup, restore), the status feed and the witness. Its
composition roots are `hobo-fleet-authority` and `hobo-fleet-witness`.

## Entry points

| Entry point | Does |
|---|---|
| `runCeremony` | Generates the NATS operator key offline as two shares |
| `rotateKey` | Add, publish, switch, remove; resumable |
| `backup`, `restore` | Archives the event store and audit stream; restores with an incarnation increment |
| `createStatusFeed` | Emits the availability events of the enrollment API and the NATS callout |
| `OpsContext`, `RotatableKey` | The operations' inputs |

Until each lane lands, its entry point has its final signature and throws
`FleetNotImplemented`.

## Gates

- **TypeScript:** `pnpm --filter @hobo/fleet-authority run build`.
- **Protobuf + CUE:** `data-models/fleet_authority.proto` holds the service's
  deployment settings and `fleet_authority.cue` constrains them; requests and
  responses are `@hobo/fleet` records. Parse, don't validate: every request body
  is parsed into its derived type (the generated record, constrained) before a command sees it.
- **PACT:** `contracts/` (a placeholder until the HTTP API pact lands).
- **Tests:** `test/`, with `*.integration.test.ts` against `nats-server`.

## Architecture placement

A service at layer 3. Each HTTP route is one command of `EnrollmentAuthority`;
commands read their stream on the event store (SQLite through
`@hobo/runtime-local` in the standalone profile, the journal store in the
high-availability profile), decide, and append `fleet.*` events. The recorder
and the registry projection are actors that build materialized views by
replay; snapshots are caches, and the read stores are the `fleet-registry` and
`fleet-views` buckets.
