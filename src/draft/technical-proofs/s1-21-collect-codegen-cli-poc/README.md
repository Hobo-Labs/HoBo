# S1-21: hobo collect + hobo codegen --check (HOBO-611)

Integrated draft POC for HOBO-611. Wires `hobo collect` and `hobo codegen
--check` authoring verbs over the existing resource-collection engine and
codegen pipeline draft proofs, with a `hello-bindle` golden manifest fixture.

## Proven Surface

- `hobo collect [--camp <name>] [--json] [--out <file>]` — prints/emits
  `hobo.manifest/v1` IR; fail-closed on errors; secret-ref redaction;
  `coverage-incomplete` labeling.
- `hobo codegen [--check] [--json]` — rewrites `.hobo/generated/` +
  `src/_generated/` in write mode; `--check` compares in-memory regeneration
  against the tree and never mutates files on drift.
- `hello-bindle` golden manifest at
  `contracts/manifests/hello-bindle.manifest.json` — byte-stable collection
  output for the Plan 21 IfC fixture (`kv("todos")` + `api("main")`).

## Dependencies (draft proofs, not re-implemented)

- `hobo-collect-cli-contract` — collect CLI wrapper
- `hobo-codegen-cli-contract` — codegen CLI wrapper + check protocol
- `resource-collection-engine-contract` — `collectBindleResources` engine

## Promotion Target

Production promotion deferred until `@hobo/collector` and production codegen
pipeline packages land (HOBO-606 + HOBO-610 Done).

Target paths: `packages/cli/src/commands/collect.ts`,
`packages/cli/src/commands/codegen.ts`.

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/s1-21-collect-codegen-cli-poc
```

## Architecture Evidence

- `data-models/` — protobuf + CUE envelope constraints
- `contracts/pacts/` — CLI→collector and CLI→codegen-pipeline consumer pacts
- `architecture/` — package boundary evidence
- `ADR.md` — parse-don't-validate and event-architecture evidence
