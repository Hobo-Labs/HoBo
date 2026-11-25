# HOBO-354 OCI Artifact Storage Proof

This proof ties the M1 registry storage slice to the descriptor and artifact-repo contracts already landed in M0.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Push fixture descriptor + artifact returns stable digest. | `push stores descriptor and artifact by stable digest...` asserts a `sha256` digest and duplicate push digest equality. |
| Pull by digest returns byte-identical content. | The same test compares pulled artifact bytes with the pushed buffer. |
| `resolve(name@version)` returns pushed digest. | The same test asserts `resolve({ name, version })` equals the pushed digest. |
| Pushing identical content twice yields same digest. | `push is idempotent for identical content...` asserts digest equality and no duplicate events. |
| Registry event emitted on push and projected into queryable catalog read-model. | `push is idempotent...` asserts `ProviderRegistered` and `CapabilityManifestUpdated` events plus catalog lookup. |
| Nonexistent digest fails cleanly. | `nonexistent digests fail cleanly...` asserts a specific not-found error. |
| Descriptor whose referenced artifact digest is absent rejected at push. | `push rejects descriptors whose referenced artifact digest is absent...` asserts digest mismatch rejection. |
| Re-push same name@version with different digest recorded as new immutable entry, never overwrite. | `re-pushing a name@version with different digest...` asserts both digests remain pullable and catalog history appends. |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\oci-artifact-storage-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
