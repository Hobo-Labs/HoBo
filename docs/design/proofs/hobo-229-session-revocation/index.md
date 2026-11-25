# HOBO-229 Session Revocation Proof

This proof backs HOBO-229, `Implement event-sourced sessions with revocation and
sign-out-everywhere`.

## Acceptance Mapping

- `session.Revoked` blocks a subsequent request even when the fixture IdP JWT is
  still valid.
- Sign-out-everywhere revokes all active sessions for the subject while leaving
  another user's session active.
- A revoked session closes affected live queries through a bounded propagation
  lane, modeling the `data.Changed` re-evaluation signal without implementing
  the full reactor.
- The lifecycle (`session.Started` -> `session.Refreshed` -> `session.Revoked`)
  replays deterministically from append-only events.

## Adversarial Mapping

- Refresh after revoke returns `session-refresh-after-revoke-denied` and emits no
  `session.Refreshed`.
- Live subscriptions bound to the revoked session are closed, not left streaming.
- Revocation propagation has an asserted 250 ms budget; propagation beyond that
  budget fails instead of becoming unbounded.

## Scope Boundary

Stateless JWKS verification remains HOBO-226. The full data-plane reactor,
`useAuth()` client, MFA/step-up, and policy authorization remain out of scope.

## Command

```powershell
npm.cmd --prefix src\draft\technical-proofs\session-revocation-contract test
```
