# End-User Authorization Policy Contract POC

This draft proves HOBO-220's end-user authorization boundary on top of the existing policy plane.

- Verified `ctx.user` becomes a `DecisionRequest.subject` with `kind=user`.
- Record owner, tenant, role, and scope facts live in policy request context.
- Owner-read authorization is expressed as a typed policy rule and evaluated by the built-in policy engine.
- `.allow()` is only authoring sugar: it lowers to the same typed policy rule and has no evaluator of its own.
- Missing or unverified `ctx.user` denies before user policy rules run.
- `policy.Decided` audit events use the canonical policy IR event shape.

## Boundary

This POC does not verify identities, fetch JWKS, build sessions, implement cross-tenant conformance, or replace the built-in policy engine.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for End User Authorization Policy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
