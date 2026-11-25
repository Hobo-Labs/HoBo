# HOBO-383 Registry Import Proof

This executable proof pins the M2 `hobo registry import` slice from [Plan 25](../../platform-engineering.md#plan-25) and [ADR-0036](../../adr/07-portability-extensibility.md#adr-0036).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Signed offline bundle loads listings into the in-boundary mirror and makes them discoverable/installable offline | `imports a signed offline bundle into an in-boundary mirror with no egress` |
| Listing failure in signature/provenance/conformance verification is refused and not loaded | `refuses failed listing verification without loading that artifact` |
| `registry.BundleImported` records per-artifact verification results | `imports a signed offline bundle into an in-boundary mirror with no egress` and `refuses failed listing verification without loading that artifact` |
| No network egress occurs during import or subsequent serving | `imports a signed offline bundle into an in-boundary mirror with no egress` and `mirror fails closed when an artifact is absent instead of live crawling` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Bundle artifact referenced by tag, not digest | `bundle tag references fail before mirror mutation` |
| Re-importing the same bundle duplicates or overwrites mirror state | `re-importing the same bundle is idempotent and does not overwrite history` |
| Missing artifact causes live crawl fallback | `mirror fails closed when an artifact is absent instead of live crawling` |

## Boundary

The proof lives in [`src/draft/technical-proofs/registry-import-contract`](../../../../src/draft/technical-proofs/registry-import-contract/README.md). It consumes [`signed-offline-bundle-contract`](../../../../src/draft/technical-proofs/signed-offline-bundle-contract/README.md), [`hobo-add-install-verification-contract`](../../../../src/draft/technical-proofs/hobo-add-install-verification-contract/README.md), and the registry descriptor contract.

It does not implement offline revocation, anti-rollback, transparency-inclusion enforcement, production OCI storage, Junction federation, model provisioning, or live registry crawling.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\registry-import-contract test
```
