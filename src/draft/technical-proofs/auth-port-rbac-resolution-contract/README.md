# Auth Port RBAC Resolution Contract

This draft package proves the HOBO-238 identity-side RBAC binding slice.
It consumes the existing RBAC role/binding model from
`src/draft/technical-proofs/rbac-role-binding-contract` and focuses on the `hobo:auth`
adapter seam: SCIM group snapshots, bounded decision caching, revocation
propagation, and Crew operator role caps.

SCIM groups are consumed only for `user` principals. Agent and service
principals keep direct role bindings only, so a Crew operator cannot widen its
role set by carrying a spoofed or stale SCIM group snapshot.

The package intentionally does not redefine the control-plane action taxonomy,
the default role matrix, deny-ceiling algebra, or policy-engine evaluation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\auth-port-rbac-resolution-contract test
```

The package test includes a compiled `tsc --noEmit` type consumer for the
published `.d.mts` surface.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Auth Port Rbac Resolution Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
