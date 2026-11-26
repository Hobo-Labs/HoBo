# HOBO-98 hobo:auth authoring surface contract

This proof package pins the authoring-side contract for end-user auth:

- `auth({ providers })` declares OIDC, custom JWT, and built-in dev/air-gap providers.
- `buildAuthManifestEntry()` lowers provider verification config into a secret-free `hobo:auth` manifest entry.
- `emitAuthConsumerContract()` emits the consumer-driven `hobo:auth` contract consumed by can-deploy and the dev fixture.
- `generateAuthSurfaceDeclaration()` proves the generated client/server shape: `ctx.user`, `ctx.tenant`, `useAuth()`, `signIn(provider)`, and `signOut()`.

The package deliberately does not implement JWKS verification, session revocation, policy `.allow()` enforcement, inbound XAA resource-server runtime, or a hosted IdP. Those are separate runtime and policy slices named in HOBO-98 scope-out.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-auth-authoring-surface test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Auth Authoring Surface.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
