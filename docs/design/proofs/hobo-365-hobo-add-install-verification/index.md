# HOBO-365 hobo add Install Verification Proof

This executable proof pins the M1 `hobo add` install-time gate from
[Plan 25](../../platform-engineering.md#plan-25),
[ADR-0023](../../adr/02-identity-security.md#adr-0023),
[ADR-0062](../../adr/07-portability-extensibility.md#adr-0062), and
[ADR-0073](../../adr/07-portability-extensibility.md#adr-0073).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Properly signed and certified listing registers as Matching-available and does not force selection | `hobo add registers a signed and certified listing as Matching-available without selecting it` |
| Broken signature, absent provenance, or missing conformance refused with catalog unchanged | `broken signature, absent provenance, and missing conformance are refused with no catalog mutation` |
| Verification happens before cost or mirror consideration | `integrity verification runs before any cost or mirror consideration` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Digest mismatch descriptor reference refused | `digest mismatch between descriptor and signed artifact is refused` |
| Validly signed but conformance-failing artifact refused | `validly signed but conformance-failing artifacts are refused` |
| Installing never marks selected, only available | `hobo add registers a signed and certified listing as Matching-available without selecting it` |

## Boundary

The proof lives in
[`src/draft/technical-proofs/hobo-add-install-verification-contract`](../../../../src/draft/technical-proofs/hobo-add-install-verification-contract/README.md).
It composes the existing
[`signed-artifact-publish-install-contract`](../../../../src/draft/technical-proofs/signed-artifact-publish-install-contract/README.md)
and
[`registry-artifact-descriptor-contract`](../../../../src/draft/technical-proofs/registry-artifact-descriptor-contract/README.md).

It does not implement resolver semantics, mirror ranking, Matching selection, air-gap import,
production signing infrastructure, or trust-tier minimum policy authoring.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-add-install-verification-contract test
```
