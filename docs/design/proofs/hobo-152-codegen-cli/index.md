# HOBO-152 Codegen CLI Proof

HOBO-152 is proven by the focused POC at
`src/draft/technical-proofs/hobo-codegen-cli-contract`.

> **Promoted (2026-07-10).** The engine now ships as typed, injectable
> production modules under `packages/cli/src/codegen/` (`types`/`engine`/
> `tree`/`fixture`/`run-codegen`/`trainables`), consumed by the
> `hobo codegen`/`hobo stub` verbs and the `hobo build` freshness gate. The
> proof is frozen in the promotions ledger (`scripts/promotions.json`) and
> stays as reference evidence only. Post-promotion hardening (HOBO-706):
> every output path and generated-import specifier is `CodegenLayout`
> configuration with overridable defaults, and the record types
> (`CodegenArtifact`/`DriftEntry`/`CodegenReport`/`TrainableStub`) are the
> generated `hobo.cli.v1` proto types from the package's
> `data-models/project_codegen.proto` (cli codegen opt-in), lowered with
> `toJson` at the CLI envelope boundary.

## Integrated S1-21 POC (HOBO-611)

Draft integration at
[`src/draft/technical-proofs/s1-21-collect-codegen-cli-poc`](../../../../src/draft/technical-proofs/s1-21-collect-codegen-cli-poc/README.md)
combines `hobo codegen --check` with seeded-drift CI gate tests.
Production promotion target: `packages/cli/src/commands/codegen.ts` (HOBO-606 +
HOBO-610 Done; awaits production codegen pipeline package).

## Acceptance Evidence

- `hobo codegen writes the documented generated layout deterministically`
  proves repeated generation, byte-identical output, and the documented
  `.hobo/generated/` plus `src/_generated/` paths.
- `--check passes on a fresh tree and never mutates the working tree` proves the
  clean CI gate.
- `--check fails with a clear diff after source or generated drift` proves the
  nonzero drift gate and JSON drift status for stale generated files.
- `--check fails after a valid source edit without rewriting generated files`
  proves source edits are detected through the same non-mutating check path.
- `generated TypeScript tree type-checks for a guest consumer` compiles a guest
  fixture against the generated declarations.

## Adversarial Evidence

- `map and set ordering is normalized so --check cannot flap` covers
  nondeterministic source ordering.
- `source parse errors name the offending file and do not half-write the
  generated tree` covers parse failure atomicity.
- `--check does not mutate when drift is present` covers failed check safety.
- `non-TypeScript guests fail with a static-analysis-required diagnostic` covers
  non-TS guest behavior.

## Scope Boundary

The package models the CLI wrapper and check protocol only. It does not build the
production codegen engine, watch-mode regeneration for `hobo dev`, or `hobo build`
regeneration behavior.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-codegen-cli-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
```
