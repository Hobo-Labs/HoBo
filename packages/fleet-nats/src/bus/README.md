# `src/bus/`: topology, credentials, the auth callout and the bus ports (L08)

The four entry points of design §7.3 that this directory implements:
`provisionTopology`, `createNatsBusConnector`, `connectAuthorityBus` and
`startCalloutResponder` (in `index.ts`). Everything else here is private to
the lane.

## Layout

| Module | Holds |
|---|---|
| `names.ts` | Stream, bucket, subject and key names of §6.7 |
| `templates.ts` | The observer, executor and dispatcher permission templates and the static users, verbatim from §6.7 |
| `wire.ts` | `BusWire`, the narrow seam between the ports and a NATS connection |
| `fleet-bus.ts` | Every port of `FleetBus` and `AuthorityBus` over a `BusWire` |
| `registry-view.ts` | The verifying `RegistryView` and the device and authority trust pins (§7.4) |
| `connect-token.ts` | The `ConnectToken` codec and minting |
| `callout-checks.ts` | The seven checks of the connect sequence |
| `callout.ts` | One sealed callout exchange: open, verify, check, answer |
| `nats-jwt.ts` | Tenant keys, account, static-user, device-user and response JWTs |
| `topology.ts` | Stream and bucket configurations and their idempotent creation |
| `resolver.ts` | Pushing an account JWT to the full resolver |
| `connection.ts` | TLS-only connection options |
| `nats-client.ts` | The client as ports: `BusConnection`, `JetStreamPort`, `JetStreamManagerPort`, `NatsClients` |
| `nats-wire.ts` | `BusWire` over JetStream |

Unit tests run every port against an in-memory `BusWire`
(`test/support/memory-wire.ts`), including `runBusConformance`. `nats-wire.ts`,
`resolver.ts` and the entry points of `index.ts` take the client as a port
(`NatsClients` in `nats-client.ts`, which the real `@nats-io` client satisfies
as it is); each frozen entry point runs its `…Over` twin on the real client.
Their unit tests run the twins over a fake server (`test/support/fake-nats.ts`),
`runBusConformance` included, and the frozen entry points against a port
nothing listens on. The
`*.integration.test.ts` files run against `nats-server` 2.15.3, the version
`mise.toml` pins (`HOBO_FLEET_NATS_SERVER_BIN` or `nats-server` on `PATH`); they
skip without it unless `CI` is set, and the lane's checks run them with it.

## Decisions

- **Derived tenant keys.** The account key, the callout xkey, the static
  users' keys and the three scoped signing keys are derived (HKDF-SHA-256)
  from the operator signing seed and the tenant id. Provisioning a tenant
  twice therefore yields the same account and keys, which is what makes
  `provisionTopology` idempotent with no store of its own. Whoever holds the
  operator signing seed can already sign any account, so the derivation
  widens nothing. The callout's `xkeySeed` is
  `tenantKeys(seed, tenant).xkey`, since `provisionTopology` does not return it.
- **The system account.** `provisionTopology` pushes the account JWT with
  `$SYS.REQ.CLAIMS.UPDATE`, as a user of a system account also derived from
  the operator signing seed (`systemAccount`, `mintSystemAccount`). The
  operator JWT must name that account as `system_account` and the server
  must preload its JWT. Its JWT states unlimited connections and
  subscriptions: the server reads an absent limit as zero and would refuse
  the provisioning connection.
- **The authority's stream rights.** The authority user names stream API
  subjects with one `*` for the stream (`$JS.API.STREAM.INFO.*`,
  `$JS.API.DIRECT.GET.*.>`, ...) rather than once per stream: the tenant
  account holds only fleet streams, so the grant is the same, and the
  per-stream list made its user JWT overflow the server's 4 KiB control line
  in the `CONNECT`.
- **Single-use tickets (A2 fallback).** `@nats-io/transport-node` calls its
  authenticator synchronously with the server nonce, and a device's `SIGN`
  key signs asynchronously, so the connector cannot put the nonce in its
  `ConnectProof`. Its proofs carry no nonce, and the callout then accepts each
  ticket once (recorded in `fleet-replay` under `nats-ticket`). A proof that
  does carry a nonce must carry this connection's. The connector fetches a
  fresh ticket for each connection attempt.
- **Trust key encoding.** §7.1 encodes an `AUTHORITY` key's value as the raw
  key, base64url; `runBusConformance` writes RFC 7517 JSON. The view accepts
  both, verifying the signature either way.
- **The authority's pin.** The authority's view verifies against the trust
  record it last published with `putTrust` in this process (its own write),
  else the one its `trust` callback answers.
- **Consumers.** A device's consumers are named by its `MemberId`, one per
  stream at a time; the authority's get a fresh random name each.
  `resumeFrom` is not consulted: every subscription states its own `from`.

## Assumptions (§13)

| Id | Result in this lane | Evidence |
|---|---|---|
| A1 | Holds on `nats-server` 2.15.3: each device writes only its own observation key and creates only its own consumers | `permissions.integration.test.ts` |
| A2 | Fallback taken: single-use tickets (the client cannot bind the nonce, above) | `callout-checks.test.ts` |
| A3 | Not verified; O5 asserted in its A3-and-A4-false form | `revocation.integration.test.ts` |
| A4 | Not verified; the bus-level bound is "next reconnect" | `revocation.integration.test.ts` |
| A5 | Holds on `nats-server` 2.15.3: the stream configuration is the primary path | `claims.integration.test.ts`, `topology.test.ts` |
| A6 | Holds on `nats-server` 2.15.3 | `permissions.integration.test.ts` |
| A7 | Holds: `newScopedSigner`, `encodeUser` with `scopedUser`, `encodeAuthorizationResponse` | `nats-jwt.test.ts` |
