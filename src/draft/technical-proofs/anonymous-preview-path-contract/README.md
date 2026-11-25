# Anonymous Preview Path Contract POC

HOBO-164 proof for the zero-setup `npx hobo up` path when the caller has no identity and has not
selected a Camp.

## What This Proves

- A no-identity/no-Camp `npx hobo up` is routed to the hosted anonymous-preview path.
- The hosted cloud can infer and auto-approve an ephemeral Camp, then return a `*.preview.hobo.dev`
  URL without requiring a prior CLI install or account.
- The deployment is recorded as unowned, claimable, and bound to a 24 hour TTL.
- The claim handoff preserves URL, state digest, and deployment id for the HOBO-136 `hobo claim`
  binding slice.
- TTL expiry requests teardown without requiring the original client to return.

## Adversarial Coverage

- Anonymous abuse/rate caps block before policy/provisioning and produce no public URL.
- Anonymous preview access denies reads/writes against any foreign tenant scope.
- Hosted policy-gate denial is a clean no-op with a reason and no partial public URL.
- Preview URLs require at least 128 bits of nonce material, so deterministic or enumerable labels are
  rejected.

## Boundary

This is a local contract POC. It does not implement hosted cloud inferred-Camp policy internals,
real provisioning, the `hobo claim` binding mechanics, self-hosted-cloud routing, DNS, gateway, or
runtime teardown workers. Those remain owned by their dedicated slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\anonymous-preview-path-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Anonymous Preview Path Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
