# HoBo Login + Claim Contract POC

HOBO-136 proof for `hobo login`, `hobo claim`, and local credential invalidation.

## What This Proves

- `hobo login` composes the Yard Identity issuer with the CLI shell and stores a
  dev JWT-SVID in an OS-credential-store seam.
- Later CLI commands receive the stored SVID by reference through command
  context, without returning the token in JSON output.
- `hobo claim <deployment>` binds an anonymous deployment to the logged-in
  identity while preserving its URL and state.
- Claiming emits a redacted `deployment.Claimed` audit event.
- Logout removes the local credential, and stale or expired SVIDs force
  `hobo login` instead of falling back to old credentials.

## Boundary

This is a local contract POC, not the production CLI or Identity service. It
does not implement the real OIDC browser/device flow, the Identity issuer,
JWKS serving, token broker, anonymous deploy creation, OS-specific keychain
adapters, or MCP per-tool auth scoping. Those remain owned by their dedicated
slices; this package pins the login/claim command contract they consume.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-login-claim-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Login Claim Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
