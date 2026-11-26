# HOBO-262 Secret-Zero Genesis Bootstrap Proof

This executable proof hardens the Yard identity genesis path described by
[Plan 06](../../ai-native-agent-auth.md#plan-06), [Plan 12](../../security-networking.md#plan-12),
[ADR-0008](../../adr/02-identity-security.md#adr-0008), and
[ADR-0074](../../adr/02-identity-security.md#adr-0074).

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Trace of genesis sequence shows root key only ever inside KMS. | `accepts a genesis trace where the durable root only exists inside target KMS` and `rejects root generation outside target KMS custody` |
| Simulated seed compromise after self-deploy yields no usable signing capability. | `rejects a captured seed credential after self-deploy handoff` |
| Attempt to stand up second issuer at same URL is rejected. | `rejects a second issuer instance at the pinned URL` |
| Self-deploy that regenerates root fails continuity invariant. | `rejects self-deploy attempts that regenerate or rotate the root` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Captured seed credential is usable post-handoff. | `rejects a captured seed credential after self-deploy handoff` |
| Seed credential becomes a durable root. | `rejects a seed credential that can act as the durable root` |
| Attacker races rogue OIDC discovery at the issuer URL before providers federate. | `rejects a rogue OIDC discovery race before provider federation` |
| A genesis step writes durable root material to disk or logs. | `rejects genesis steps that write root material to disk or logs` |

## Scope Guard

The proof is a local contract POC. It does not implement the issuer/KMS runtime from HOBO-71,
genesis Org-Admin or break-glass policy, KMS adapter internals, or cross-Yard Junction federation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\secret-zero-genesis-bootstrap-contract test
```
