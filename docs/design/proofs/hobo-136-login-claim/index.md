# HOBO-136 Login + Claim Proof

HOBO-136 is proven by the focused POC at
[`src/draft/technical-proofs/hobo-login-claim-contract`](../../../../src/draft/technical-proofs/hobo-login-claim-contract/README.md).

## Acceptance Evidence

- `hobo login --json` stores a usable JWT-SVID in the OS credential-store seam
  and returns only a redacted credential summary.
- A later command receives the stored SVID reference through the HOBO-115 CLI
  context path.
- `hobo claim <deployment> --json` binds an anonymous deployment while
  preserving its URL and state.
- Claiming emits a redacted `deployment.Claimed` audit event.
- Logout invalidates the local credential.

## Adversarial Evidence

- Expired and logged-out SVIDs force `hobo login`; no stale credential fallback
  is exposed.
- Deployments already owned by another account cannot be claimed.
- File-backed credential stores refuse group/world-readable modes.
- Interrupted OIDC authorization leaves no partial credential behind.

## Scope Boundary

The POC consumes the existing Yard issuer/JWT-SVID/token-audit contracts. It
does not implement the Identity issuer, real OIDC flow, token broker internals,
anonymous deployment creation, or MCP tool scoping.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-login-claim-contract test
```
