# Yard domain validation contract POC

Independent POC for HOBO-142. It composes the Yard-level `domain("shop.com")`
declaration with the HOBO-101 shadow DNS port, the HOBO-113 validation gate, and
the HOBO-138 gateway health seam.

## Scope

- Yard-scoped domain declaration with provider-global ownership, `.routes()`,
  `.routing()`, and per-Camp overrides.
- Shadow DNS staging before any live-zone mutation.
- Concrete validation check implementations for multi-vantage resolution,
  TTL-aware propagation, ACME/DNS-01 readiness, and endpoint health.
- Failure events that name the failing check and block promotion.
- Adversarial guards for split-horizon resolver disagreement and premature TTL
  completion.

## Out of Scope

- Live-zone promotion after validation.
- Staged/canary cutover and rollback.
- Routing-policy realization beyond the shadow record contract.
- Certificate issuance or rotation.
- Junction cross-cloud federation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\yard-domain-validation-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Yard Domain Validation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
