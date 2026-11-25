# HOBO-238 Auth Port RBAC Resolution Proof

This proof covers HOBO-238's identity-side role-resolution boundary. It consumes
the completed HOBO-158 RBAC role/binding contract and proves how `hobo:auth`
SSO/SCIM snapshots populate `subject.roles` with bounded cache and revocation
behavior.

## Scope

- `src/draft/technical-proofs/auth-port-rbac-resolution-contract` resolves `hobo:auth` SCIM group
  snapshots for user principals into RBAC subjects using the existing
  role/binding contract.
- Custom roles are accepted only as validated action-taxonomy subsets from the
  existing RBAC contract.
- Role resolution has a bounded subject cache and revocation propagation bound.
- SCIM revocation invalidates cached subjects before TTL expiry and stale auth
  snapshots cannot keep a revoked role alive.
- Crew operator principals are capped to their bound role and cannot self-escalate
  through asserted roles or SCIM group spoofing.
- The published `.d.mts` surface compiles through a package-local
  `tsc --noEmit` type consumer.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Fixture SCIM group maps to Org-Admin and populates `subject.roles`. | `maps a fixture SCIM group to Org-Admin and populates subject.roles` |
| Custom role composed from action ids resolves. | `resolves a custom role composed from action ids` |
| Revoked SCIM membership stops granting within the propagation bound. | `stops granting a revoked SCIM role within the propagation bound before cache TTL expiry` and `removes every role from a revoked SCIM group even when the group maps multiple roles` |
| Crew operator principal carries assigned role and cannot exceed it. | `keeps Crew operator principals capped to their bound role` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Self-asserted role claim not backed by SCIM binding is ignored. | `ignores self-asserted roles that are not backed by an auth-port binding` |
| Revoked role lingers past cache TTL or propagation bound. | `stops granting a revoked SCIM role within the propagation bound before cache TTL expiry`, `removes every role from a revoked SCIM group even when the group maps multiple roles`, and `fails closed when revocation propagation misses its bound` |
| Operator agent inherits a broader role than its binding. | `keeps Crew operator principals capped to their bound role` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\auth-port-rbac-resolution-contract test
```
