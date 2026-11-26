# HOBO-226 Auth Federate + Verify Proof

This proof backs HOBO-226, `Implement hobo:auth federate+verify: stateless JWKS verification -> ctx.user`.

## Acceptance Mapping

- Fixture IdP JWT verifies through JWKS into typed `ctx.user`.
- Expired, wrong-issuer, wrong-audience, tampered, `alg:none`, and HMAC tokens are rejected.
- `user.Authenticated` is emitted through the identity event contract.
- Verified tenancy claim resolves `ctx.tenant`; missing tenancy fails closed.

## Adversarial Mapping

- `alg:none` and HMAC tokens are rejected before any signature trust decision.
- Unconfigured provider adapters are rejected before a verified token can become `ctx.user`.
- JWKS key rotation accepts old and new tokens only while both kids are published.
- Tenant access is limited to the verified `ctx.tenant`; unresolved tenant fails closed.

## Scope Boundary

Sessions/revocation, `useAuth()`/`signIn()` clients, `.allow()` policy authorization, and the thin
built-in dev provider remain owned by their separate slices.

## Command

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-auth-federate-verify-contract test
```
