# HOBO-75 Collection Coverage Gate Contract

This draft package proves the static-analysis side of the IfC collection-coverage gate.
It defines a small contract surface for comparing statically declared authoring resources
and `bind` edges with what run-to-collect observed.

## Contract Surface

- `analyzeDeclaredResources(sourceText, { fileName })` scans a constrained TypeScript
  authoring surface for static `@hobo/bindles` resource declarations and `bind` edges.
  It honors named imports, aliases, and namespace imports from `@hobo/bindles` so local
  helper functions with the same names do not create false gate failures.
- `evaluateCollectionCoverage({ sourceText, observedResourceIds, observedBindKeys, fileName })`
  returns a machine-readable can-deploy dimension result.
- `assertCanDeployCollectionCoverage(...)` throws `CollectionCoverageError` when the
  coverage dimension must fail closed.

## Acceptance Evidence

- A resource declared only in an unobserved `else` branch fails with
  `collection.coverage.unobserved-resource`, naming the resource, branch, file, and line.
- A fully observed declaration set passes.
- The result object includes declared, observed, unobserved, unreachable, and unresolved
  declarations for agent-readable repair.
- Dead code declarations are reported distinctly from reachable-but-unobserved declarations.
- Dynamic/computed resource names fail closed with
  `collection.coverage.cannot-prove-resource-name`.
- Static `bind("from", "to")` edges and documented `bind: { db }` option references
  participate in the same machine-readable coverage result.
- Canonical resource factories such as `database`, `kv`, `service`, and `web` are detected
  inside nested `b.use(...)` authoring forms.
- One-line branch declarations still distinguish unreachable code from a live unobserved
  `else` declaration.

## Scope Boundary

This package does not implement the run-to-collect engine, the full Gatekeeper/can-deploy
composition, or non-TypeScript analyzers. It is a branch-local proof of the coverage contract
that those later systems consume.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\collection-coverage-gate-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Collection Coverage Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
