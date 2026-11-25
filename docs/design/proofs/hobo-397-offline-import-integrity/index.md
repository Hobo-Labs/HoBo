# HOBO-397 Offline Import Integrity Proof

This executable proof covers the M3 adversarial hardening required by
[ADR-0036](../../adr/07-portability-extensibility.md#adr-0036) and
[ADR-0062](../../adr/07-portability-extensibility.md#adr-0062). It hardens the
existing signed-bundle and registry-import boundaries without reimplementing the
bundle format, happy-path mirror importer, KMS/HSM internals, or live registry
compromise defenses.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| A revoked-key bundle is refused at import. | `refuses a bundle signed by a key in the imported offline revocation list` rejects both signed listings and records `revocation.revoked_key`. |
| An older-timestamp bundle is refused, with only explicit audited force-downgrade allowed. | `blocks an older bundle timestamp/version unless an explicit audited force-downgrade is supplied` rejects timestamp and version rollback, then accepts only with `approvedBy`, `reason`, and `ticket` on the event. |
| A bad or absent inclusion proof is refused against the pinned root. | `refuses missing or bad transparency inclusion proofs against the pinned root` covers missing proof material and root mismatch; `applies transparency and anti-rollback gates to base images` proves base images are also gated. |
| All checks run with no egress. | The success, transparency-failure, and missing-offline-material tests install an `onEgressAttempt` counter and assert it remains zero; `offline importer source exposes no network egress sinks` guards against direct live fallback. |
| Each failure is recorded on `registry.BundleImported`. | The gate tests assert `event.verification.<gate>` is `failed` and artifact reasons name the failing gate. |
| Each is a standing CI assertion. | `npm.cmd --prefix src\draft\technical-proofs\offline-import-integrity-contract test` is a Node test package and root `npm.cmd test` discovers it. |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Key compromised before the bundle was cut. | Imported revocation material is bound to the bundle ref and checked before mirror mutation. |
| Rollback masquerading as a fresh import. | Per-listing `buildTimestamp` is compared to installed state and fails closed unless explicitly force-downgraded. |
| Validly-signed bundle never publicly logged. | Inclusion proof material must exist offline, match the listing digest, and verify against the pinned log root. |
| Force-downgrade must never be silent. | The accepted downgrade event carries `forceDowngrade.approvedBy`, `reason`, and `ticket`. |
| Base image rollback or unlogged base image. | Base-image build timestamps and inclusion proofs flow through the same offline gates before mirror mutation. |

## Commands

```powershell
npm.cmd --prefix src\draft\technical-proofs\offline-import-integrity-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```
