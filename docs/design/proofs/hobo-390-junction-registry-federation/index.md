# HOBO-390 Junction Registry Federation Proof

This executable proof pins the M2 Junction registry/signed-artifact federation slice from [Plan 25](../../platform-engineering.md#plan-25), [ADR-0043](../../adr/07-portability-extensibility.md#adr-0043), and [ADR-0036](../../adr/07-portability-extensibility.md#adr-0036).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Certified listing in Yard A is exported as a signed bundle, transferred, and imported into Yard B | `shares a certified listing from one Yard to another through a signed bundle without shared registry state` |
| Yard B can discover/install the listing offline-style | `shares a certified listing from one Yard to another through a signed bundle without shared registry state` |
| `junction.ArtifactShared` is emitted | `shares a certified listing from one Yard to another through a signed bundle without shared registry state` |
| Yard B verifies against its own trust boundary and refuses a failing bundle | `refuses a peer bundle that does not satisfy the target Yard trust boundary` |
| Yards keep independent Registry logs with no shared mutable Registry state | `shares a certified listing from one Yard to another through a signed bundle without shared registry state` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Peer certification must not auto-trust a bundle at the target Yard | `refuses a peer bundle that does not satisfy the target Yard trust boundary` |
| Sharing must not create a central Registry | `shares a certified listing from one Yard to another through a signed bundle without shared registry state` |
| Source revocation must not leave the imported artifact silently live at the target | `applies source Yard yanks as target-local registry state instead of leaving the import silently live` |

## Boundary

The proof lives in [`src/draft/technical-proofs/junction-registry-federation-contract`](../../../../src/draft/technical-proofs/junction-registry-federation-contract/README.md). It consumes [`registry-import-contract`](../../../../src/draft/technical-proofs/registry-import-contract/README.md), [`signed-offline-bundle-contract`](../../../../src/draft/technical-proofs/signed-offline-bundle-contract/README.md), and the install verification contract.

It does not implement Junction identity trust establishment/revocation, cross-cloud connectivity inference, cross-cloud policy packs, production Registry storage, or the signed bundle/importer internals.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\junction-registry-federation-contract test
```
