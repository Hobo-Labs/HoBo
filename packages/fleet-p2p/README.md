# `@hobo/fleet-p2p`

The peer-to-peer transport of HoBo Fleet (ADR-0182): direct, authenticated
device-to-device streams dialled by Ed25519 key over QUIC (iroh), with relay
fallback, for shells, port forwards and bulk transfer. The only package with the
native binding.

## Entry points

| Entry point | Does |
|---|---|
| `createP2pTransport({ relayUrls })` | A `FleetTransport` of kind `p2p` |

Until its lane lands it has its final signature and throws
`FleetNotImplemented`.

## Gates

- **TypeScript:** `pnpm --filter @hobo/fleet-p2p run build`.
- **Protobuf + CUE:** `data-models/fleet_p2p.proto` holds the transport's local
  settings and `fleet_p2p.cue` constrains them. Parse, don't validate: a session
  is opened only from a parsed, authorised `SessionGrant`, and the peer's
  identity is a derived type proven by the handshake, never read from a header.
- **PACT:** `contracts/` (a placeholder).
- **Conformance:** passes `runTransportConformance` from `@hobo/fleet/testing`.
- **Integration:** `test/p2p.integration.test.ts` against the pinned iroh relay.

## Architecture placement

An adapter package at layer 3. It handles no command and emits no events of its
own: session grants are commands of the authority, and the acceptor's signed
session-close fact is recorded by the authority's recorder into the event store,
from which the usage projection (materialized view) is built. It runs no actor,
keeps no snapshot and has no read store.
