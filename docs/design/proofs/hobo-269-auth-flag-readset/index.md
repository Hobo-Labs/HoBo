# HOBO-269 — Auth-State + Flag-State Read-Set Proof

This proof pins the Reactor contract for auth and feature-flag state as first-class read-set members:

- `session.Revoked` wakes subscriptions scoped to that principal/session and pushes `decision: "deny"` with an empty result.
- `flag.Changed` wakes materializations that declared the changed flag ruleset and re-pushes with the latest flag value.
- Flag narrowing removes rows from an already-open subscription instead of waiting for a client poll or redeploy.
- Subscriptions without the matching session or flag read-set member are not woken.
- Auth recomputation failure is fail-closed (`auth-recompute-failed`), never a stale privileged push.

Executable proof lives in `src/draft/technical-proofs/auth-flag-readset-contract`.

Scope intentionally excludes bounded fan-out/coalescing and session/flag event producers; HOBO-288 owns the fan-out hardening that this issue unblocks.
