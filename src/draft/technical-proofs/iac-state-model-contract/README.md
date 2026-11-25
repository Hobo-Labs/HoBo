# IaC State Model Contract

HOBO-139 proves the M1 per-resource IaC state seam without implementing a real Pulumi backend,
ActorHost, drift loop, or adopt-in-place importer.

## Scope

- `resourceStackKey()` pins each stack to `tenant/deployment/resource`.
- `createInMemoryStateBackend()` models the Yard object-store-backed stack state.
- `createInMemoryLeaseAuthority()` models the ActorHost single-writer lease used before state writes.
- `createIacStateModel()` applies or destroys one resource stack, emits resource lifecycle events, and resolves stack outputs into dependent bindings.

## Guardrails

- Destroying one resource deletes only that resource's stack.
- Stack outputs are captured into `resource.Provisioned` before dependent binding resolution.
- A second writer for the same resource is rejected by the ActorHost lease even if the backend lock is lost.
- Orphaned stacks remain visible for reconciliation instead of being deleted.
- Output collisions fail closed before a dependent resource receives ambiguous refs.
- Backend unavailability fails before a resource is marked provisioned.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-state-model-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Iac State Model Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
