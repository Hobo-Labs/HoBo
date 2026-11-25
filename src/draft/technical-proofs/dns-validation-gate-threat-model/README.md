# DNS validation-gate threat model spike

Independent spike for HOBO-189. It records the DNS validation-gate threat model
behind [ADR-0101](../../../../docs/design/adr/07-portability-extensibility.md#adr-0101)
as executable requirements before HOBO-142 implements the concrete checks.

## Recommendation

- Treat the gate as fail-closed: disagreement, stale evidence, unfinished checks,
  thrown checks, or promote-time evidence drift block promotion.
- Use at least three independent DNS vantage resolvers and fail on disagreement,
  not majority-pick a winner.
- Confirm propagation only after the previous and candidate TTL windows have
  elapsed and all required vantages report the same record version.
- Bind ACME/DNS-01 challenges to the exact FQDN, key thumbprint, and CSR intent;
  sibling or unrelated wildcard evidence never satisfies the gate.
- Re-pin evidence immediately before the live-zone write; if the pinned digest
  changes, the validate-to-promote window closes by failing the promotion.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\dns-validation-gate-threat-model test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Dns Validation Gate Threat Model.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
