# S0-03 @hobo/core draft POC (HOBO-580)

Draft traceability copy of the S0-03 promotion. **Production code lives in
`packages/core/` (`@hobo/core`).** This tree is retained for draft-layer evidence
and should stay aligned with the production package when either changes.

## Scope

- EventEnvelope parse boundary with typed `EnvelopeParseError`
- Capability Manifest four-file bundle parser with cross-file invariants
- Port descriptors (WIT-style refs) and minimal DI container
- Public API snapshot guard (`CORE_API_SNAPSHOT`, `validatePublicTypeSurface`)
- Protobuf + CUE data-models, PACT boundary contract

## Out of scope

- OCSF/OTLP export mappings (remain in `src/draft/technical-proofs/hobo-core-contract/`)
- Production `packages/core/` workspace slot (promoted in HOBO-580)

## Validation

```bash
pnpm --prefix src/draft/projects/s0-03-hobo-core build
pnpm --prefix src/draft/projects/s0-03-hobo-core test
pnpm run test:file src/draft/projects/s0-03-hobo-core/test/envelope.test.ts
pnpm run test:file src/draft/projects/s0-03-hobo-core/test/core-contract-boundary.contract.test.ts
```

The `core-contract-boundary.contract.test.ts` file uses `node:test` (not Vitest) so
`pnpm run test:contract:consumer` can execute it through the root contract lane.

## Architecture evidence

- `data-models/` — protobuf + CUE constraints for envelope, manifest, port descriptor
- `contracts/core-contract-boundary.pact.json` — CoreContractBoundary consumer/provider pact
- `ADR.md` — parse-don't-validate and event-envelope command/event evidence

## Promotion path

Promoted to `packages/core/` in HOBO-580. Keep draft and production trees aligned.
