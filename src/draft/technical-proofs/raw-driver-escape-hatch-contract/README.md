# Raw Driver Escape Hatch Contract

Independent proof package for HOBO-265.

It models `.raw(driver => ...)` as an explicitly non-portable, driver-typed read escape hatch over logical projections. Runtime tests prove portability and isolation debt are surfaced, projected-sink writes fail closed, and sinks without raw capability refuse raw calls. The TypeScript fixture proves wrong-driver dialect calls fail at compile time.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Raw Driver Escape Hatch Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Testing

Run `pnpm --filter @hobo-draft/raw-driver-escape-hatch-contract test` (Vitest,
followed by `tsc -p tsconfig.typecheck.json`). The implementation exports the
`RawResult` and per-driver types (`PostgresRawDriver`, `MongoRawDriver`, …)
that `test/type-consumer.ts` pins against cross-driver misuse.
