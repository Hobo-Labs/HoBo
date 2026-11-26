# HOBO-374 Mirror Digest Selection Proof

This executable proof pins the M2 mirror-selection slice from
[ADR-0073](../../adr/07-portability-extensibility.md#adr-0073) and the Dispatcher tiebreak
constraint from [ADR-0071](../../adr/01-architecture-core.md#adr-0071). It builds on the
HOBO-365 install-time verification boundary and keeps HOBO-391's digest-mismatch hard-fail UX out
of scope.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| N mirrors serving byte-identical digests choose cheapest/fastest and fetched artifact matches agreed digest | `byte-identical verified mirrors choose the cheapest mirror only after every mirror verifies` |
| Cost is never consulted before verification | The same test asserts all verification events precede the Dispatcher cost callback. |
| Choosing mirror never changes the resolved digest | `changing the mirror winner never changes the resolved digest or fetched bytes` |
| Fixture proves byte-identical regardless of winner | The same test changes the winner and compares returned bytes plus digest. |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Cheaper mirror serving a different digest is not preferred | `a cheaper mirror with a different digest fails before Dispatcher cost is consulted` |
| Unverified mirror is never cost-eligible | `unverified mirrors are never cost-eligible and cannot be promoted by cheap cost` |
| Cost cannot promote failed verification | The same test asserts no Dispatcher callback and empty cost-eligible set. |
| Selected mirror mutates after verification | `a selected mirror whose fetched bytes no longer match the agreed digest is refused` |

## Boundary

The proof lives in
[`src/draft/technical-proofs/mirror-digest-selection-contract`](../../../../src/draft/technical-proofs/mirror-digest-selection-contract/README.md).
It models the mirror-selection consumer of HOBO-365's verified install boundary rather than
duplicating signing, provenance, or conformance checks.

Out of scope remains digest mismatch hard-fail UX, namespace shadowing, dependency resolution,
the Dispatcher cost model, and air-gap mirror import.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\mirror-digest-selection-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
