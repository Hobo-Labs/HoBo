# `@hobo/fleet/transport` (L28)

Session authorisation, AEAD framing, transport selection, the session server
and verified blob fetch (design §6.12). Adapters live elsewhere: `p2p` in
`@hobo/fleet-p2p`, `overlay` in `@hobo/connectivity`, `bus-relay` in
`@hobo/fleet-nats`.

| Entry point | What it does |
|---|---|
| `authoriseSession(peer, grant, { self, registry, nowMs })` | Verifies the grant's authority signature against the pinned trust record, its §7.2 constraints, tenant, `issued_at` (60 s skew), expiry and a lifetime of at most an hour; that it names this device as acceptor and the proven `peer` as initiator; that both members are `ACTIVE` (a person's CLI initiator has no member id and must name a principal); and that a fleet the acceptor belongs to allows the purpose in `policy.session_purposes`. An empty list allows nothing. Every refusal is `session-denied` with `detail.check`. |
| `frameStream(raw, { send, receive })` | ChaCha20-Poly1305 frames: 4-byte length, ciphertext and tag; nonce = four zero bytes and a 64-bit counter per direction. An empty frame ends the stream; a stream that stops without it fails as truncated. Reordered, replayed or forged frames fail authentication. Byte counts are plaintext bytes. |
| `selectTransport(transports, grant, signal, log)` | Dials `p2p`, then `overlay`, then `bus-relay`, whatever order it is given; a failed or throwing dial falls through. Logs `hobo_fleet_transport_selected` with `transport` and `fallbacks`. When all fail: the shared error code if every failure had the same one, otherwise `unavailable`, with `detail` naming each failure. |
| `serveSessions(deps)` | Accepts on every transport, authorises before any byte, serves the session and publishes a `SessionClose` fact signed with the device `SIGN` key on the event channel (kind `session-close`), logging `hobo_fleet_session_closed`. |
| `fetchBlob(stream, digest)` | Requests one blob, yields its bytes as they arrive and fails before completing unless they hash to `digest`. |

## Session protocol

Messages on an accepted stream are a 1-byte tag, a 4-byte big-endian length
(at most 1 MiB) and a payload: `REQUEST` 1, `INPUT` 2, `END` 3, `OUTPUT` 4,
`EXIT` 5 (signed 32-bit exit code), `ERROR` 6 (UTF-8 reason).

- **Shell** (`SHELL`, order id required): the initiator sends `INPUT` chunks
  and `END` (at most 16 MiB); the acceptor runs `/bin/sh -s` with that input in
  the order's sandbox, streams `OUTPUT` and ends with `EXIT`. With no sandbox
  for the order it answers `ERROR`: a session never runs on the host.
- **Forward** (`FORWARD`, order id required): the same exchange, running
  `nc 127.0.0.1 <port>` inside the order's sandbox.
- **Blob** (`BLOB`): one `REQUEST` with a digest the grant names; the acceptor
  reads `/hobo/blobs/sha256/<hex>` in the order's sandbox, verifies the hash
  and answers `OUTPUT` chunks and `END`, or `ERROR`.

## Limits

`Sandbox.exec` takes its standard input whole, so shell and forward sessions
are one batch of input and a stream of output, not interactive terminals or
live sockets. Only the acceptor publishes a session-close fact here; the
initiator's fact belongs to whoever holds its keys and bus (the agent, L07).
