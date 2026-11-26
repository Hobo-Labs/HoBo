# HOBO-75 Collection Coverage Gate Proof

HOBO-75 is proven by the focused POC at
[`src/draft/technical-proofs/collection-coverage-gate-contract`](../../../../src/draft/technical-proofs/collection-coverage-gate-contract/README.md)
and the consolidated S1-17 draft at
[`src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc`](../../../../src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc)
(HOBO-607).

## Acceptance Evidence

- Branch coverage test proves a resource declared only inside an unexercised branch fails
  can-deploy with a precise diagnostic naming the resource and branch.
- Green-path test proves collection passes when all statically declared resources are observed.
- Machine-readable result test proves agents can read declared, observed, unobserved,
  unreachable, and unresolved declarations.
- Negative tests cover sibling branch declarations, dead-code distinction, dynamic resource
  names, import provenance, one-line branch parsing, nested `b.use(...)` forms, and static
  `bind` plus `bind: { db }` edge coverage.

## Scope Boundary

This branch intentionally stops at the static-analysis coverage contract. The run-to-collect
engine, full Gatekeeper composition, and non-TypeScript guest analyzers remain owned by their
separate slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\collection-coverage-gate-contract test
```
