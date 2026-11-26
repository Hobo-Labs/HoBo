# Token Replay Resistance Contract

Independent POC for HOBO-255. It composes the JWT-SVID, ID-JAG, XAA, provider
access-token, and identity-event draft seams into an adversarial replay harness.

## What This Proves

- A captured JWT-SVID is rejected at the TTL boundary and after the rotation
  rollover window.
- A target-A ID-JAG cannot be replayed at target B.
- A consumed ID-JAG nonce cannot be redeemed a second time; concurrent attempts
  admit only the first redemption.
- A provider access token reused after expiry is rejected.
- An inbound ID-JAG replayed against a HoBo app is rejected.
- Every replay denial emits a validated `token.Denied` audit event without raw
  credential material.
- Fresh, within-window first use still succeeds for each credential family.

## Boundary

This package does not implement production credential minting, STS exchange,
resource-server signature verification, broker caches, or the concrete runtime
defenses from HOBO-90, HOBO-99, HOBO-110, HOBO-230, or HOBO-233. It is a
branch-local regression harness over those contracts.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\token-replay-resistance-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Token Replay Resistance Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
