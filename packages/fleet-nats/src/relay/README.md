# Bus-relay transport (L37)

`createBusRelayTransport(bus)` is the third `FleetTransport` of design §6.12:
always available, slowest. It carries a session as messages on
`fleet.relay.<toMemberId>.<relaySessionId>` through the agent's live bus
(`bus` is the agent's `bus()`; a dial fails `unavailable` while it answers
undefined). Only the endpoints can read a session: the bus sees ciphertext.

## Identity and keys

- The transport identity is `relay:<seal public key>`: what this transport can
  prove is possession of the device's `SEAL` key.
- Every dial is its own relay session: a random 128-bit hex id on the subject
  (never the grant's session id, which is free text and may be reused by a
  retried dial).
- Keys are `sessionKeys(X25519(initiator SEAL, acceptor SEAL), "<relay
  session id>:<grant session id>")`, and the bytes are framed by
  `frameStream` (ChaCha20-Poly1305, counter nonce). Because the relay session
  id is fresh, no two dials share a key, so a counter nonce never repeats.

## Handshake

1. The dialler publishes `OPEN` (its member id and the grant envelope) and a
   proof message through the framing.
2. The acceptor checks the grant names it (member id and SEAL key) and that
   the dialler's member id is the grant's initiator, then checks the proof.
   Only the holder of the initiator's SEAL key can produce one that
   authenticates, so the proven peer is `relay:<initiator seal key>`.
3. It asks `authorise(peer, grant)`; nothing reaches the handler unless it
   answers true. Then it answers an accept message through the framing (which
   proves its own SEAL key to the dialler), or `RESET`.

A dial answers `session-denied` on a `RESET` or an unauthenticated answer, and
`unavailable` when no answer comes within 15 s, the signal aborts, or there is
no bus.

## Wire

One type byte and a body: `OPEN` 1 (member-id length, member id, grant),
`DATA` 2, `CREDIT` 3 (u32 big-endian), `END` 4, `RESET` 5. Flow control is by
credit: each side may have at most 1 MiB unread at the other and the reader
returns credit as its consumer takes bytes; a sender past its credit is reset,
and a writer waiting 30 s for credit abandons the session. `DATA` payloads are
at most 128 KiB, well under the server's 1 MiB `max_payload`.

## Limits

- `CREDIT`, `END` and `RESET` are not authenticated: a member that can publish
  to `fleet.relay.>` and learns a relay session id can end that session early,
  as dropping its messages could. It cannot read or inject session bytes: a
  forged `DATA` fails authentication and ends the stream.
- `close` is a full close: after the peer's `END`, reads drain what arrived and
  end, and writes are dropped.
- At most 256 relay sessions are open per transport; further `OPEN`s are reset.
