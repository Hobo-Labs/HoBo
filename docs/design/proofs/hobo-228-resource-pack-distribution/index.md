# HOBO-228 Resource Pack Distribution Proof

This executable proof pins the M4 provider Resource Pack distribution slice from
[Plan 25](../../platform-engineering.md#plan-25),
[ADR-0036](../../adr/07-portability-extensibility.md#adr-0036),
[ADR-0057](../../adr/07-portability-extensibility.md#adr-0057), and
[ADR-0062](../../adr/07-portability-extensibility.md#adr-0062).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Provider plus default Resource Definitions are bundled as a signed pack with conformance and provenance | `provider pack publishes signed definitions with conformance and provenance` |
| `hobo add` installs on a fresh Yard and Camp naming provider plus IaC matches the whole manifest with no per-resource config | `hobo add installs on a fresh Yard and Camp provider plus IaC matches the whole manifest` |
| Unsigned or uncertified packs are refused without catalog mutation | `unsigned and uncertified provider packs are refused with the Yard unchanged` |
| The same pack imports via a signed offline bundle in an air-gapped fixture and verifies in-boundary | `signed offline bundle imports in-boundary without egress and updates anti-rollback state` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Stale conformance report versus bundled provider code or definitions | `stale conformance is rechecked against bundled provider code and definitions` |
| Equal-scoring definition winner changes need catalog content-hash attribution | `equal-scoring winner changes are attributed to catalog and pack content hashes` |
| Air-gap old vulnerable pack anti-rollback | `air-gap import refuses an older vulnerable pack by anti-rollback state` |
| Pack install trying to force selection only makes the pack available | `pack force-selection directives are ignored; install only makes definitions available` |

## Boundary

The proof lives in
[`src/draft/technical-proofs/resource-pack-distribution-contract`](../../../../src/draft/technical-proofs/resource-pack-distribution-contract/README.md).
It composes the existing
[`signed-artifact-publish-install-contract`](../../../../src/draft/technical-proofs/signed-artifact-publish-install-contract/README.md)
fixture and keeps production signing, Registry lifecycle, capability discovery, Matching internals,
monetization, and revocation internals out of scope.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\resource-pack-distribution-contract test
```
