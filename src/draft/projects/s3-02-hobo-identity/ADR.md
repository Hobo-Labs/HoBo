# ADR — S3-02 hobo-identity draft POC

## Parse-don't-validate

Untrusted attestation documents and JWT-SVID claims cross exactly one parser boundary each
(parse, don't validate) and become **parsed derived types** downstream code consumes:

- `verifyWorkloadAttestation` → `AttestationVerdict` (`attested` | `unattested` with reason)
- `verifyJwtWithJwks` → verified claims or typed verification failure
- `validateIdentityEvent` → required `identity.Issued` / `identity.Rotated` fields

Downstream callers (`IdentityService`, Gateway auth simulation) consume parsed verdicts and
events; they do not re-validate raw DTO fields.

## Event architecture

Identity follows Plan 06 §6.2 attest → issue → rotate:

| Step | Command | Event | Actor |
|---|---|---|---|
| Attest + issue | `IssueSvidFromAttestation` | `identity.Issued` | Yard Identity service |
| Rotate | `RotateSvid` | `identity.Rotated` | Yard Identity service |

Events carry `svidRef` references, never token values. The **event store**, **materialized
view**, **snapshot**, and **read store** are owned by runtime slices — this POC appends to an
in-memory audit list only to prove event shape and sequencing.

## OIDC provider seam

The issuer exposes OIDC discovery and JWKS for outbound federation (ADR-0023 key-TTL posture).
Signing keys stay behind the KMS seam and are non-exportable in the in-memory fixture adapter.

## Adversarial posture

- Unattested or forged attestation → no SVID, no `identity.Issued`
- Tenant binding from measured launch, not caller claims
- Scope widening during rotation → denied (`scope-widening-requires-live-identity`)
- Expired attestation measurements fail closed
