# Session Revocation Contract

This draft package is the HOBO-229 proof for event-sourced app-user sessions.
It composes the existing `hobo:auth` stateless JWKS verifier with `session.*`
identity events, then denies requests from the replayed session state.

## Proven Behaviors

- `session.Revoked` blocks the next request that still carries an unexpired JWT.
- Sign-out-everywhere appends revocation facts for every active session for the subject.
- Live queries bound to a revoked session are closed through a bounded propagation lane.
- Refresh after revoke is denied; no `session.Refreshed` event is emitted.
- Session state replays deterministically from append-only `session.*` events.

## Scope Boundary

The package does not implement stateless JWKS verification, the full reactor,
`useAuth()`, or MFA. Those remain owned by HOBO-226, data-plane reactor slices,
SDK client slices, and future auth-hardening work.

## Command

```powershell
npm.cmd --prefix src\draft\technical-proofs\session-revocation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Session Revocation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
