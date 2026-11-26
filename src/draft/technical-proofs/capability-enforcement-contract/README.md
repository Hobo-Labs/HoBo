# Capability Enforcement Contract

Independent HOBO-19 proof for deny-by-default capability enforcement and the
usage-inferred grant set.

**Promoted to production:** `packages/core/src/capability/` and
`packages/runtimes/runtime-local/src/capability/link-table.ts` (S1-04 / HOBO-593).

This package models the security seam between the authoring/collection result
and the runtime membrane:

- static analysis records the used capability operations in `hobo.manifest/v1`;
- `.allow()` narrows that used set, and narrow-below-usage fails can-deploy;
- runtime calls require both a link-table route and an inferred grant;
- capability handles are unforgeable object references, not ambient ids;
- dynamic capability calls fail closed when static analysis cannot prove the
  operation.

Scope intentionally excludes policy-engine composition, SVID/token scoping,
NATS/JetStream lattice transport, deadline/backpressure semantics, and dynamic
verb grants beyond the fail-closed stub.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\capability-enforcement-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Capability Enforcement Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
