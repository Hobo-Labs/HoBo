# HOBO-34 WebSocket Streamer Fan-out Proof

HOBO-34 is proven by the focused POC at
[`src/draft/technical-proofs/websocket-streamer-fanout-contract`](../../../../src/draft/technical-proofs/websocket-streamer-fanout-contract/README.md).

## Acceptance Evidence

- `broadcast(channel, msg)` fans out over the runtime-local Streamer while a
  stopped Yard probe would throw on any control-plane data-path call.
- Focused tests assert zero Yard calls on the websocket data path.
- `send-to` writes a direct Streamer frame to the recipient connection.
- `leave` removes channel membership before any later broadcast can fan out.
- `principal(conn)` returns the verified principal bound at connection accept.
- Outbound connect setup requires the `connect` grant rather than ambient access.
- Deny-by-default `.allow()` verbs block an ungranted `broadcast`.

## Adversarial Evidence

- A connection broadcasting to a channel outside its principal tenant fails
  closed before fan-out.
- A connection must join a tenant-scoped channel before it can broadcast there.
- Unknown websocket verbs are rejected when the connection grant is normalized.

## Scope Boundary

Auth/IdP federation, per-frame audit policy, `ws.*` durable lifecycle events,
Gateway transport, and real Streamer backends remain outside this slice.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\websocket-streamer-fanout-contract test
```
