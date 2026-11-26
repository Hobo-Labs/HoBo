# HOBO-44 JWT-SVID Contract Proof

This executable proof pins the M0 contract for HoBo workload identity from
[Plan 6](../../ai-native-agent-auth.md#plan-06), [Plan 12](../../security-networking.md#plan-12),
and [ADR-0008](../../adr/02-identity-security.md#adr-0008).

## Contract Surface

- JWT-SVIDs carry `iss`, `sub`, `aud`, `exp`, `nbf`, `iat`, `tenant`, `parentPrincipal`,
  `codeVersion`, and least-privilege `scope`.
- SPIFFE IDs use the Yard trust domain:
  - `spiffe://yard/<tenant>/agent/<name>`
  - `spiffe://yard/<tenant>/<bindle>/<resource>`
- The `tenant` claim must match the tenant embedded in the SPIFFE subject.
- Scope entries are explicit `{ port, resource, verbs[] }` grants; ambient admin grants are invalid.

## Proof Boundaries

This proof is structural. It rejects unsigned compact tokens and `alg: none`, but it does not perform
JWKS signature verification or issue SVIDs. Issuer/JWKS runtime, rotation, workload attestation,
and token exchange remain separate identity slices.

## Executable Checks

Run:

```powershell
node --test src\draft\technical-proofs\hobo-jwt-svid-contract\test\jwt-svid-contract.test.ts
```

The checks prove:

- the versioned schema publishes the required claim set,
- a signed compact JWT-SVID parses and exposes the Yard SPIFFE identity,
- workload and agent namespaces round-trip,
- malformed, tenant-confused, empty, and overlong SPIFFE IDs fail,
- `alg: none`, unsigned tokens, and expired claims fail,
- scope grants require a port/resource/verb shape and reject duplicate or ambient-admin verbs.
