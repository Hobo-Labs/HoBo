# HOBO-279 Genesis Org-Admin and Break-Glass Proof

This proof extends the existing genesis/break-glass draft for the M3 identity
hardening slice described by [Plan 06](../../ai-native-agent-auth.md#plan-06)
and [ADR-0074](../../adr/02-identity-security.md#adr-0074).

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| `hobo yard up` seeds exactly one audited, rotatable `identity.GenesisAdmin`. | `yard genesis emits exactly one auditable Org-Admin fact and role binding`, `genesis seeding is one-time and replay cannot mint a second Org-Admin`, and `genesis admin can rotate immediately while retaining an audit trail` |
| Genesis admin can bind first real roles. | `genesis admin can bind the first real role before normal RBAC is bootstrapped` |
| Offline-signed override recovers when the IdP is unreachable and mandatory policy blocks changes. | `offline-signed break-glass recovers when IdP and mandatory policy block normal changes` |
| Every successful break-glass use is audited. | `break-glass signature replay is rejected and successful use is never silent` |
| Forged or unsigned override is refused. | `normal IdP path and self-grant cannot recover a bricked mandatory rule` and `tampered offline break-glass credentials fail closed before recovery` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Second genesis fact mints a standing backdoor. | `genesis seeding is one-time and replay cannot mint a second Org-Admin` |
| Break-glass becomes an unauthenticated waiver. | `normal IdP path and self-grant cannot recover a bricked mandatory rule` |
| Attacker triggers recovery without the offline key. | `tampered offline break-glass credentials fail closed before recovery` |
| Genesis admin stays active after bootstrap. | `hobo doctor flags an unrotated genesis admin and clears after rotation` |

## Scope Guard

The proof stays inside the contract boundary. It does not implement
mandatory-rule/deny-ceiling algebra, the live-approver waiver path, SSO/SCIM
role binding, KMS custody for offline keys, IdP integration, or provider/runtime
wiring.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\genesis-breakglass-contract test
```
