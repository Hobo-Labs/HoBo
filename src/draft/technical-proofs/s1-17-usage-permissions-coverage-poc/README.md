# S1-17 usage permissions + collection coverage draft POC (HOBO-607)

Independent draft proof for [HOBO-607](https://linear.app/quickdeploy-ai/issue/HOBO-607):
usage-inferred permissions, narrow-only `.allow()`, and the static-analysis
collection-coverage gate.

**Promotion target:** `packages/collector/src/permissions/` and
`packages/bindles/src/allow.ts` once S1-16 (`@hobo/collector`) lands.

## Scope

- `buildUsagePermissionManifest` + `projectPermissionTriple` (FR-002 IAM + link + token-scope triple)
- `parseUsagePermissionInput` parse-don't-validate boundary
- `.allow()` authoring surface with zero-verb and dynamic-grant guards
- `analyzeDeclaredResources` / `evaluateCollectionCoverage` / `assertCanDeployCollectionCoverage`
- Append-only gate events: `capability.ContractEvaluated|Failed`, `coverage.Evaluated|Failed`
- Protobuf + CUE data-models, PACT boundary contracts

## Out of scope

- Run-to-collect collection engine (HOBO-606 / S1-16)
- Wasm-host runtime enforcement, IaC IAM emission, full Gatekeeper composition

## Validation

```bash
pnpm --prefix src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc build
pnpm --prefix src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc test
pnpm run test:file src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc/test/usage-permissions.test.ts
pnpm run test:file src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc/test/collection-coverage.test.ts
```

## Architecture evidence

- `data-models/usage_permissions.proto` + `.cue`
- `data-models/collection_coverage.proto` + `.cue`
- `contracts/capability-contract-gate.pact.json`
- `contracts/collection-coverage-gate.pact.json`
- `ADR.md`

## Source proofs promoted

- `src/draft/technical-proofs/usage-inferred-permissions-contract/` (HOBO-70)
- `src/draft/technical-proofs/collection-coverage-gate-contract/` (HOBO-75)
- `src/draft/epic-proofs/sdk-authoring-ifc-bindles/` (narrowing fixture)
