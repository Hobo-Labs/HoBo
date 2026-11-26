# Audit Explorer Scope Contract

HOBO-427 proof for Audit Explorer M0 scope and acceptance.

This package records the branch-sized Productization M0 contract for Audit
Explorer. It intentionally does not build UI, event-store runtime, search,
export delivery, RBAC enforcement, support ticketing, CLI/MCP commands, or
identity runtime. It proves the accepted boundary and follow-up gate before
M1/M2/M3/M4 Audit Explorer work can fan out.

## Proof Surface

- [`src/audit-explorer-scope.ts`](./src/audit-explorer-scope.ts) defines the
  parsed M0 scope record, personas, scope in/out, boundaries, dependencies,
  audit fact classes, query axes, export evidence, and follow-up gate.
- [`test/audit-explorer-scope.test.ts`](./test/audit-explorer-scope.test.ts)
  proves every HOBO-427 acceptance bullet and adversarial guard.
- [`architecture/`](./architecture) carries the protobuf, CUE, and Pact evidence
  required by the architecture guard.

## Acceptance Coverage

- User/business goal and primary personas are explicit.
- Scope in/out and non-goals are recorded.
- Service, UX, security, and support boundaries are mapped to owning
  initiatives.
- Evidence required for M1 design and contract proof is listed.
- Follow-up implementation issues remain blocked until M0 acceptance is
  recorded.
- Adversarial creep into UI, event-store runtime, export service, RBAC
  enforcement, support ticketing, credential exposure, or customer-data search
  is rejected by tests.

## Commands

`@types/node` is declared in this package because `tsconfig.json` requests the
Node type library and CI runs package typechecks without relying on hoisted
transitive types.

```powershell
npm.cmd --prefix src\draft\exp-proofs\audit-explorer-scope-contract test
npm.cmd --prefix src\draft\exp-proofs\audit-explorer-scope-contract run typecheck
```
