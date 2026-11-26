# HOBO-63 hobo:auth Consumer Contract Proof

This executable proof pins the M0 consumer-driven `hobo:auth` contract from
[Plan 6](../../ai-native-agent-auth.md#plan-06),
[ADR-0038](../../adr/02-identity-security.md#adr-0038), and
[ADR-0070](../../adr/02-identity-security.md#adr-0070).

## Contract Surface

- The contract declares the expected `ctx.user` subject shape: claims, roles,
  scopes, platform tenant, and app tenant.
- `hobo dev` satisfies that contract with a contract-asserted dev principal,
  generated offline from the contract.
- Session overrides are bounded by the contract, so role and tenant testing is
  first-class without granting arbitrary roles or tenants.
- The canonical bytes used by local dev and by the `can-deploy` fixture-IdP
  gate are identical.
- Dev auth bypass grants authentication only; capability calls still require an
  explicit linked/granted `(port, resource, action)` entry.

## Proof Boundaries

The proof intentionally does not assert JWT/JWKS verification, JWT `alg`, issuer,
audience, expiry, or revocation. Those checks belong to the fixture-IdP
`can-deploy` gate, matching the honest gap documented in ADR-0070.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-auth-consumer-contract test
```

The checks live in
`src/draft/technical-proofs/hobo-auth-consumer-contract/test/auth-consumer-contract.test.ts`.
