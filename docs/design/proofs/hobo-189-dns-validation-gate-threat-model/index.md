# HOBO-189 DNS Validation-Gate Threat Model Proof

This proof records the M0 spike for the DNS validation-gate threat model from
[Plan 12](../../security-networking.md#plan-12) and
[ADR-0101](../../adr/07-portability-extensibility.md#adr-0101).

## Proof Surface

- [Draft package](../../../../src/draft/technical-proofs/dns-validation-gate-threat-model/README.md)
- [Executable checks](../../../../src/draft/technical-proofs/dns-validation-gate-threat-model/test/threat-model.test.ts)

## Proven Constraints

- A single honest-looking DNS vantage is never sufficient.
- Multi-vantage DNS disagreement fails closed instead of majority-selecting a target.
- Propagation evidence waits for both previous and candidate TTL windows and requires stable serial evidence.
- ACME DNS-01 evidence is bound to the exact FQDN, key thumbprint, and CSR intent.
- Endpoint health must probe the candidate host and verify the expected gateway identity.
- Validate-to-promote races are blocked by re-checking a pinned evidence digest before the live write.

## Scope Boundary

The proof is a spike and does not implement the HOBO-142 domain resource, concrete DNS/ACME/health
checks, staged cutover, gateway behavior, or the HOBO-193 adversarial hardening tests.

## Verification

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\dns-validation-gate-threat-model test
```
