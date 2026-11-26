# Compliance Evidence Pack Scope

Executable M0 proof for HOBO-452, defining Compliance Evidence Pack scope and acceptance before
later design or implementation work fans out.

## Focused Gate

```powershell
pnpm --prefix src\draft\exp-proofs\cx\compliance-evidence-pack-scope test
```

## Proof Surface

- `COMPLIANCE_EVIDENCE_PACK_SCOPE` records goal, personas, scope in/out, non-goals, assurance
  packet sections, service/UX/security/support/legal/release boundaries, design/ADR references,
  owning initiative dependencies, M1 evidence, and follow-up gate.
- `validateComplianceEvidencePackScope` fails closed when M0 scope drifts into legal approval, live
  compliance implementation, support data access, or proofless customer-facing claims, and when the
  accepted M0 record loses its goal, personas, scope-out/non-goal text, or required boundaries.
- `classifyComplianceEvidenceRequest` routes adjacent requests to Legal, Privacy & Terms Readiness,
  Security Verification, Tenant Data Lifecycle, Support Workflow, V1 Release Program & Cutline, or
  Backup & Restore.
- `canCreateComplianceEvidenceFollowUp` blocks M1-M4 follow-up issues until M0 scope evidence is
  accepted.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | Tests assert `goal` and five persona records. |
| Scope in/out and non-goals are recorded. | Scope arrays are exported and validated for creep. |
| Initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary, design ref, ADR ref, and dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Seven M1 evidence records are asserted. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateComplianceEvidenceFollowUp` blocks implementation phases until accepted. |

## Scope Guards

This proof deliberately does not approve legal artifacts, build live compliance systems, grant
support access to production customer data, publish customer-facing compliance claims, or create
downstream implementation issues before M0 acceptance.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Compliance Evidence Pack Scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
