# DNS Validation Rebinding Guard Contract

Independent contract POC for HOBO-193. It hardens the custom-domain validation
gate from [ADR-0101](../../../../docs/design/adr/07-portability-extensibility.md#adr-0101)
against DNS rebinding, spoofed resolver evidence, sibling-name ACME evidence,
and validate-to-promote races.

## Contract

- Validation pins a canonical `sha256:` digest over the DNS resolution, TTL,
  ACME, and endpoint-health evidence.
- Multi-vantage resolution requires three independent answers and fails closed
  on any target disagreement.
- TTL propagation requires both the previous-live and candidate TTL windows plus
  stable serial evidence.
- ACME evidence must bind to the exact FQDN, key thumbprint, and CSR intent.
- Promotion rechecks the pinned digest and the live-zone baseline before writing
  the intended record.

## Scope Boundary

This package does not implement the production DNS provider, ACME client,
gateway, planner, relay SSRF controls, or the base HOBO-142 domain resource. It
models the adversarial guard around an already staged validation gate.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\dns-validation-rebinding-guard-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Dns Validation Rebinding Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
