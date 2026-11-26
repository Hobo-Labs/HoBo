# HOBO-391 Dependency-Confusion Guard Proof

This executable proof pins the M3 adversarial registry guard from
[ADR-0073](../../adr/07-portability-extensibility.md#adr-0073) and the generated
stack's post-conformance safety posture in
[Plan 23](../../generated-stack.md#plan-23). It composes the HOBO-370 resolver
pin contract, HOBO-365 install verification boundary, and HOBO-374 mirror
cost-tiebreak proof while keeping full resolver, registry compromise, and
air-gap integrity work out of scope.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Mirror A/B serving the same `name@version` with different digests fails resolve closed and surfaces both digests. | `mirror digest disagreement for one pinned coordinate fails closed and surfaces every digest` asserts no selection, no cost-eligible mirrors, and both mirror digests in the error. |
| Cheaper mirror with a different digest is never preferred. | `a cheaper mirror with a different digest is never cost-eligible` asserts Dispatcher is not called and no selection is made. |
| Typosquatted or shadowed name does not resolve in place of the pinned coordinate. | `typosquatted, namespace-shadowed, and higher-version listings cannot replace an immutable pin` rejects a near-name listing, an alternate-scope namespace shadow, and a higher-version same-name listing when the exact pin is absent. |
| CI assertion exists. | `npm.cmd --prefix src\draft\technical-proofs\registry-dependency-confusion-guard-contract test` runs the guard as a Node test package, and the root `npm.cmd test` gate discovers it. |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Higher-version same-name listing on a public mirror does not float across immutable pin/digest check. | `typosquatted, namespace-shadowed, and higher-version listings cannot replace an immutable pin` fails with `artifact.pinned_coordinate_absent`, not an upgrade. |
| Mirror byte flip caught by digest on re-fetch. | `mirror byte flips are caught by digest verification on re-fetch` re-hashes selected bytes and fails with `artifact.fetch_digest_mismatch`. |
| Cost never breaks tie between non-identical digests. | The digest disagreement tests assert `costEligibleMirrorIds` is empty, while `byte-identical candidates are the only mirror ids exported for the HOBO-374 tiebreak` keeps ranking outside this package. |

## Boundary

The proof lives in
[`src/draft/technical-proofs/registry-dependency-confusion-guard-contract`](../../../../src/draft/technical-proofs/registry-dependency-confusion-guard-contract/README.md).
It models the adversarial guard around an already resolved immutable artifact
pin. It does not implement happy-path mirror cost economics, the full
distributed-artifact resolver, registry-compromise/sig-bypass defenses, or
air-gap/offline install integrity.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\registry-dependency-confusion-guard-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```
