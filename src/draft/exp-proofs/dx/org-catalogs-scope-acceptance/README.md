# Org Catalogs Scope Acceptance

Executable M0 proof for HOBO-424, defining Org Catalogs scope and acceptance before later design or
implementation work fans out.

## Focused Gate

```powershell
npm.cmd --prefix src\draft\exp-proofs\org-catalogs-scope-acceptance test
```

## Proof Surface

- `ORG_CATALOGS_SCOPE` records goal, personas, scope in/out, non-goals, boundaries, catalog kinds,
  entry states, required evidence fields, dependencies, M1 evidence, and follow-up gate.
- `validateOrgCatalogsScope` fails closed when M0 scope drifts into registry storage, install
  resolver runtime, marketplace/payout work, billing, or RBAC implementation.
- `classifyOrgCatalogDecision` routes adjacent decisions to Registry & Distribution, Marketplace
  UX / Publisher Portal, Member/RBAC Administration, Billing & Credits, or Org Catalogs.
- `canCreateOrgCatalogFollowUp` blocks M1-M4 follow-up issues until M0 scope evidence is accepted.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | Tests assert `goal` and four persona records. |
| Scope in/out and non-goals are recorded. | Scope arrays are exported and validated for creep. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateOrgCatalogFollowUp` blocks implementation phases until accepted. |

## Scope Guards

This proof deliberately does not build registry storage, artifact publishing, install resolution,
marketplace UI, RBAC grants, billing, provider execution, or policy enforcement.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Org Catalogs Scope Acceptance.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
