# HOBO-164 Anonymous Preview Path Proof

HOBO-164 is proven by the focused POC at
[`src/draft/technical-proofs/anonymous-preview-path-contract`](../../../../src/draft/technical-proofs/anonymous-preview-path-contract/README.md).

## Acceptance Evidence

- The no-identity/no-Camp test proves `npx hobo up` routes to the hosted anonymous-preview path,
  needs no prior install, returns a `*.preview.hobo.dev` URL, records an inferred ephemeral Camp, and
  emits a 24 hour TTL message with the `hobo claim` path.
- The claim-handoff test proves the deployment record is unowned and claimable while preserving URL,
  deployment id, and state digest for the HOBO-136 claim-binding slice.
- The TTL test proves expiry requests teardown even if the original client never returns.

## Adversarial Evidence

- Abuse/rate-cap denial blocks before policy/provisioning and returns no public URL.
- Tenant authorization tests deny anonymous cross-tenant reads and writes.
- Hosted policy-gate denial returns a reason without recording a deployment or leaking a partial URL.
- URL entropy tests reject guessable or enumerable preview labels.

## Scope Boundary

The POC consumes hosted policy, abuse gating, provisioning, DNS, gateway, and claim binding as seams.
It does not implement hosted cloud policy internals, real provider provisioning, self-host routing,
or `hobo claim` binding mechanics.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\anonymous-preview-path-contract test
```
