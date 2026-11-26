# Domain validation gate contract POC

Independent POC for HOBO-113. It pins the DNS/custom-domain pre-promotion gate
that consumes the HOBO-101 `hobo:dns` shadow-zone path and emits the
`domain.ValidationStarted`, `domain.Validated`, and `domain.ValidationFailed`
event family.

## Scope

- Validation gate orchestration contract for the four required check kinds:
  multi-vantage resolve, TTL-aware propagation, ACME/challenge, and endpoint
  health.
- Shadow staging handoff to the pre-validation DNS port, with a live-zone
  untouched invariant.
- Event sequence conformance guard preventing `domain.Validated` unless every
  required check has passed.
- Fail-closed behavior for red, throwing, timed-out, or unfinished checks.

## Out of Scope

- Real multi-vantage DNS, ACME, propagation, or endpoint probe implementations.
- Staged/canary cutover after validation.
- Certificate issuance or rotation.
- Concrete cloud DNS provider adapters.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\domain-validation-gate-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Domain Validation Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
