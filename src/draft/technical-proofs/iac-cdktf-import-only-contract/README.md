# @hobo/iac-cdktf import-only backend contract

Independent proof for HOBO-191. The package models `@hobo/iac-cdktf` as a
read-only `IacProvider` adapter for brownfield CDKTF/Terraform state. It reads
existing state into HoBo resource records and rejects authoring operations.

## Proven behavior

- `refresh({ stateFile })` reads a CDKTF/Terraform state fixture into HoBo
  resource records.
- Mapped Terraform resource types become `adopted` records with CDKTF
  provenance and PortabilityReport entries.
- Unknown Terraform resource types become `external` records instead of being
  dropped.
- `preview`, `apply`, and `destroy` reject with the precise import-only error.
- The import -> plan -> no-op diff conformance path stays drift-detect only.
- A proposed delete/create against adopted resources is blocked before apply.
- Malformed or partial state files fail closed.
- The public `.d.mts` surface is consumed by a strict TypeScript fixture.

## Scope boundaries

This is the backend/read-path contract only. It does not implement the
`hobo import` command family, production `external`/`adopted` resource kinds,
real CDKTF execution, Pulumi/OpenTofu/Crossplane adapters, or authoring new
infrastructure.

## Check

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-cdktf-import-only-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Iac Cdktf Import Only Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Testing

Run `pnpm --filter @hobo-draft/iac-cdktf-import-only-contract test` (Vitest,
followed by `tsc --noEmit -p tsconfig.types.json`). The implementation now
exports `CdktfImportedResource`, `CdktfImportReport`, and `CdktfDriftReport`
with fully typed drift/import shapes, exercised by `test/type-consumer.ts`.
