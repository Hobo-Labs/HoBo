# `@hobo/fleet-p2p`

The peer-to-peer transport of HoBo Fleet (ADR-0182): direct, authenticated
device-to-device streams dialled by Ed25519 key over QUIC (iroh), with relay
fallback, for shells, port forwards and bulk transfer. The only package with the
native binding.

## Entry points

| Entry point | Does |
|---|---|
| `createP2pTransport({ relayUrls })` | A `FleetTransport` of kind `p2p` |

## How it works

- **One endpoint, one ALPN.** `start(keys)` binds one iroh endpoint from the
  minimal preset (no n0 relays, no DNS or pkarr discovery), with the ALPN
  `hobo/fleet/1` and a relay map of exactly `relayUrls`. A relay URL is
  `https://`, or `http://` on a loopback address (a relay in development mode);
  anything else throws `FleetParseError`. An empty list disables relaying.
- **Identity.** The endpoint's secret key is SHA-256 over a domain label and the
  device SIGN key's signature of that label (`src/secret.ts`): `DeviceKeys`
  never hands out private material, and Ed25519 signatures are deterministic,
  so the same SIGN key always gives the same endpoint id. `start` answers that
  id (lowercase hex) as the transport identity, which the key bundle records as
  the `TRANSPORT` key; a rotated SIGN key gives a new one.
- **Dialling.** `dial({ grant })` reads the acceptor's transport identity from
  the grant and dials that endpoint id at each configured relay (iroh upgrades
  to a direct path by hole punching where it can). It opens one stream and
  writes the grant as the first frame: a 4-byte big-endian length and the
  `SignedEnvelope` (at most 64 KiB).
- **Accepting.** For each connection the acceptor reads the grant frame (within
  the handshake bound; a malformed or oversized frame ends the connection
  without asking anyone), then calls `authorise(peer, grant)` with the endpoint
  id the QUIC handshake proved. Only when it answers true, and the grant names
  this endpoint as acceptor, does the acceptor write one `ACCEPTED` byte and
  hand the stream and decoded `SessionGrant` to the handler. No payload byte
  moves either way before that byte. A refused dial fails `session-denied`; an
  unreachable peer, a timeout or an aborted signal fails `unavailable`.
- **Counting and closing.** Streams count payload bytes only. `close` ends the
  send side, waits briefly for the peer's acknowledgement and answers the
  counts; the connection closes once the peer has ended its side too, so an
  answer written just before `close` is not lost.
- **No prebuilt binding.** On a platform the binding has no prebuild for,
  `start` answers an empty transport identity (the device publishes no
  `TRANSPORT` key), every dial fails `unavailable`, and `accept` takes
  nothing; selection moves on to `overlay` and `bus-relay`.

## Assumptions (design §13)

| # | Result | How |
|---|---|---|
| A8 | **Holds** with `@number0/iroh` 1.2.0 | `test/iroh.test.ts`: two endpoints from the minimal preset (no discovery) with a custom relay map of exactly the configured URLs, one ALPN; the accepted connection's `remoteId()` is the dialler's id; an endpoint serving another ALPN is not reached |
| A9 | **Holds** | `test/iroh.test.ts`: `EndpointBuilder.secretKey` takes the caller's 32 bytes; the endpoint id equals the Ed25519 public key `node:crypto` derives from them |

No fallback is taken. Tests that may skip are named `[A8] …` and skip only
where the binding has no prebuild for the platform.

## Gates

- **TypeScript:** `pnpm --filter @hobo/fleet-p2p run build`.
- **Protobuf + CUE:** `data-models/fleet_p2p.proto` holds the transport's local
  settings and `fleet_p2p.cue` constrains them. Parse, don't validate: relay
  URLs are parsed once by `parseRelayUrls`, a session is opened only from a
  parsed, authorised `SessionGrant`, and the peer's identity is a derived type:
  the endpoint id the QUIC handshake proved, never one read from a frame.
- **PACT:** `contracts/` (a placeholder).
- **Unit:** `pnpm exec vitest run packages/fleet-p2p/test --exclude '**/*.integration.test.ts'`:
  `runTransportConformance` over an in-memory endpoint (`test/support/fake-network.ts`)
  and over the real binding on loopback with direct addresses; the
  no-binding platform; malformed first frames; relay URL parsing.
- **Integration (O12):** `test/p2p.integration.test.ts` runs
  `runTransportConformance` between two `createP2pTransport` instances that
  reach each other only through the provisioned `iroh-relay` (on `PATH`, or
  `HOBO_FLEET_IROH_RELAY_BIN`), started in development mode on a loopback
  port. With `CI` set a missing relay fails; otherwise it skips.

## Architecture placement

An adapter package at layer 3. It handles no command and emits no events of its
own: session grants are commands of the authority, and the acceptor's signed
session-close fact is recorded by the authority's recorder into the event store,
from which the usage projection (materialized view) is built. It runs no actor,
keeps no snapshot and has no read store.
