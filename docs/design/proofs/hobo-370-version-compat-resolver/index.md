# HOBO-370 Version/Compat Resolver Proof

HOBO-370 is proven by the focused POC at
[`src/draft/technical-proofs/distributed-artifact-resolver-contract`](../../../../src/draft/technical-proofs/distributed-artifact-resolver-contract/README.md).
It implements the ADR-0095 resolver semantics over a catalog snapshot without
crossing into install verification, yanks, mirror costing, codemods, or air-gap
import.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Passes committed HOBO-340 spike vectors. | Each vector from `src/draft/technical-proofs/version-compat-resolution-semantics/fixtures/resolution-vectors.json` is imported and asserted through `canonicalResolutionResult(resolveDistributedArtifacts(vector))`. |
| Same snapshot twice gives identical output. | `catalog order is not part of resolver output identity` compares canonical outputs for forward and reversed catalog order. |
| Diamond conflict produces deterministic error. | The HOBO-340 incompatible diamond vector asserts `dependency-conflict` with sorted path evidence. |
| Compatible transitive constraints resolve to the intersection. | `late transitive constraint narrows an already selected root to the intersection` reselects the lower shared artifact version instead of failing a satisfiable graph. |
| Records pins into manifest IR. | `manifest IR pin records freeze floating ranges to concrete digests` asserts `hobo.manifest/v1` artifact pin records with immutable digest pins and the catalog snapshot hash. |
| Existing immutable pin mutation is refused. | `ordinary plan refuses in-place mutation of an existing immutable manifest pin` returns `immutable-pin-mutation` instead of selecting a replacement digest. |
| Lockfile and manifest pins cannot diverge. | The imported HOBO-340 lock mismatch vector and `lockfile set must exactly match the manifest pin set when present` reject changed, missing, and extra lock entries. |
| Existing immutable pin must exist in the catalog snapshot before preservation. | `ordinary plan cannot preserve a manifest pin absent from the catalog snapshot` returns `manifest-pin-not-in-catalog`. |
| Catalog reordering cannot change the result. | The dedicated catalog-order test and the imported HOBO-340 order vector both reverse fixture order and compare the same digest set. |
| Floating `^` range is frozen at resolve time. | The manifest IR test resolves `provider.aws ^1.2.0` to the concrete `1.3.0` digest pin. |
| Transitive major boundary fails closed. | `transitive major-boundary constraint fails closed after a root pin was selected` adds a later transitive `^2.0.0` constraint and asserts deterministic conflict. |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\distributed-artifact-resolver-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
