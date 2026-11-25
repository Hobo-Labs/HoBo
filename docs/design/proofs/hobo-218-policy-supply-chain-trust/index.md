# HOBO-218 Policy Supply-Chain Trust Proof

HOBO-218 proves the adversarial trust boundary around policy-as-code supply
chain inputs from [Plan 29](../../contracts-policy-flags.md#plan-29),
[ADR-0023](../../adr/02-identity-security.md#adr-0023),
[ADR-0036](../../adr/07-portability-extensibility.md#adr-0036),
[ADR-0057](../../adr/07-portability-extensibility.md#adr-0057),
[ADR-0074](../../adr/02-identity-security.md#adr-0074), and
[ADR-0096](../../adr/02-identity-security.md#adr-0096).

The executable proof lives in
[`src/draft/technical-proofs/policy-supply-chain-trust-contract`](../../../../src/draft/technical-proofs/policy-supply-chain-trust-contract/README.md).

The proof covers:

- unsigned and tampered policy packs fail closed before load;
- wrong-key forged packs never load;
- federated mandatory policy flags cannot be downgraded in transit undetected;
- policy packages carry verifiable CycloneDX SBOM and SLSA-style provenance;
- unsigned offline registry bundle import is denied and audited;
- signed/provenanced bundle import is allowed by the trust gate;
- derivative policy-engine swaps are gated, audited, and require approval;
- fail-open or unattested swapped engines are rejected before runtime.

Scope intentionally stops before production pack signing, cross-Yard
attestation, KMS internals, registry storage, and generalized SBOM/SLSA CI.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\policy-supply-chain-trust-contract test
```
