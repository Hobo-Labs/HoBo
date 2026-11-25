# HOBO-7 Signed Artifact Publish/Install Proof

This executable proof pins the M2 signed artifact trust boundary from
[Plan 9](../../generated-stack.md#plan-09),
[Plan 23](../../generated-stack.md#plan-23),
[ADR-0023](../../adr/02-identity-security.md#adr-0023),
[ADR-0036](../../adr/07-portability-extensibility.md#adr-0036), and
[ADR-0062](../../adr/07-portability-extensibility.md#adr-0062).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Publish -> artifact carries verifiable signature + provenance attestation | `publish attaches a verifiable signature, SLSA provenance, and conformance report` |
| Install tampered artifact rejected; unsigned artifact rejected | `install refuses tampered or unsigned artifacts and leaves the catalog unchanged` |
| Digest-pinned install reproducible | `digest-pinned install is reproducible for the same artifact and provenance input` |
| Trust-level metadata surfaced for policy minimum | `publish attaches a verifiable signature, SLSA provenance, and conformance report` and `provenance is tied to the trusted sandbox builder identity and passing conformance` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Validly-signed-but-malicious is an honest limit | `valid signature is reported as integrity verification, not proof of benignity` |
| Provenance forged by compromised pipeline ties to sandboxed builder identity | `provenance is tied to the trusted sandbox builder identity and passing conformance` |
| Dependency confusion on pulls | `dependency-confusion attempts fail closed by digest and coordinate scope` |

## S0-10 draft POC (HOBO-587)

S0-10 work-in-progress lives in
[`src/draft/technical-proofs/componentize-artifact-trust-contract`](../../../../src/draft/technical-proofs/componentize-artifact-trust-contract/README.md)
as an independent POC while S0-07/S0-09 land. Promotion target:
`packages/componentize/src/publish/artifact-trust.ts`,
`packages/componentize/src/publish/events.ts`, and
`packages/componentize/test/publish-verify.test.ts`.

## Boundary

The proof lives in
[`src/draft/technical-proofs/signed-artifact-publish-install-contract`](../../../../src/draft/technical-proofs/signed-artifact-publish-install-contract/README.md).
It does not implement registry listing lifecycle, air-gap offline revocation, anti-rollback,
transparency-log validation, offline bundle import, production signing-key operations, or
malicious-publisher detection. Those remain outside HOBO-7's scope.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\signed-artifact-publish-install-contract test
```
