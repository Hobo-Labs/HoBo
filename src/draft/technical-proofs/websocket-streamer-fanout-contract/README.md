# WebSocket Streamer Fan-out Contract

Independent POC for HOBO-34. It composes the HOBO-23 Streamer runtime port,
the HOBO-33 `hobo:websocket` extension shape, and deny-by-default websocket
verbs into one data-path proof.

## Public Surface

- `createWebsocketStreamerFanout({ streamer, yard })` creates a runtime that
  registers principal-bound websocket connections.
- `connect({ connectionId, principal, allow, mode })` requires `accept` by
  default, requires `connect` when `mode: "connect"` is requested, and returns a
  Streamer-backed readable for that connection.
- `join(connectionId, channel)` requires `subscribe` and enforces tenant-scoped
  channel authorization.
- `broadcast(connectionId, channel, message)` requires `broadcast`, writes
  message frames through Streamer, and never calls the Yard.
- `sendTo(from, to, message)` requires `send` and keeps direct sends inside the
  sender/recipient tenant boundary.
- `principal(connectionId)` returns the verified `PrincipalRef` bound at
  connection acceptance.

## Acceptance Evidence

- Broadcast still fans out while a stopped Yard probe would throw on any
  control-plane call.
- Focused tests assert zero Yard calls on the broadcast/send data path.
- `send-to` writes a direct frame through Streamer.
- `leave` removes channel membership before a later broadcast can fan out.
- `principal(conn)` returns the verified user principal.
- Outbound connect setup requires the `connect` grant rather than ambient access.
- Missing `.allow("broadcast")` denies before any frame is emitted.

## Adversarial Evidence

- Cross-tenant channel joins fail closed before fan-out.
- A connection must already be a member of a channel before broadcasting to it.
- Unknown websocket verbs are rejected at connection setup instead of becoming
  ambient grants.

## Scope Boundary

This POC does not implement `hobo:auth`, IdP federation, per-frame audit policy,
the durable `ws.*` lifecycle event family, Gateway transport, or Streamer
provider backends.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\websocket-streamer-fanout-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Websocket Streamer Fanout Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
