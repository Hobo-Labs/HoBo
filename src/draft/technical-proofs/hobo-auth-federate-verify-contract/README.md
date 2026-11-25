# hobo:auth Federate + Verify Contract

Independent POC for HOBO-226. The package proves the `hobo:auth` runtime verifier seam without
building sessions, client auth hooks, policy authorization, or a hosted IdP.

## Proven Surface

- `createHoboAuthVerifier()` verifies OIDC/custom-JWT tokens against the configured issuer,
  audience, accepted algorithms, and published JWKS on each request.
- A verified token maps into typed `ctx.user` claims and resolved `ctx.tenant`.
- `user.Authenticated` is emitted through the identity event contract.
- `requireTenantAccess()` denies access unless the target tenant matches the verified
  `ctx.tenant`.

## Guards

- Expired, wrong-issuer, wrong-audience, tampered, `alg:none`, and HMAC-presented tokens fail
  closed.
- Unconfigured provider adapters fail closed before a verified token can be stamped with an
  ambient provider name.
- Missing tenancy claims fail closed and never imply all-tenants.
- JWKS rotation overlap accepts any token whose `kid` remains published.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-auth-federate-verify-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Auth Federate Verify Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
