# @hobo/schema-tools

The production protobuf/CUE codegen orchestrator (ADR-0037). The `hobo-codegen`
CLI wraps `buf generate` (protoc-gen-es) and `cue vet` over every package that
opts in by giving its `data-models/` a `buf.yaml` module marker; generated
TypeScript lands in each package's checked-in `src/_generated/`, and
`hobo-codegen --check` is the drift gate CI runs. That directory belongs only
to protobuf codegen; other generators use a suffixed sibling such as
`src/_generated-assets/` or `src/_generated-art/`. See [`ADR.md`](./ADR.md).

## Honest scope

Implemented: workspace discovery (`packages/*/data-models` plus nested category
packages under `adapters/`, `providers/`, `runtimes/`, `iac/`, `build/`), buf-based
generation, fixture vetting against `data-models/fixtures/{valid,invalid}/`,
drift detection, and the JSON `CodegenReport` envelope with its exit-code
mapping. Deliberately not here: no schema registry, no runtime validation
service — this is a deterministic build-time tool; the drift gate only compares
regenerated output against the checked-in tree.

## Commands

```bash
pnpm --filter @hobo/schema-tools run build
pnpm --filter @hobo/schema-tools run typecheck
pnpm --filter @hobo/schema-tools run lint
pnpm --filter @hobo/schema-tools run test
```

Offline failure tests mock `fetch`; they never depend on a real CUE download
failing on the host. Toolchain selection requires a successful version probe
with the pinned CUE version.

## Parse, don't validate

CLI argv crosses one parser boundary and becomes the frozen derived type
`CodegenInvocation`; downstream code never sees raw argv. The report is itself
a derived type built by `createCodegenReport` (`CodegenReport`, with
`DriftEntry` and `CueViolation` members and `parseCodegenStatus` for the status
enum) — parse, don't validate. The report's wire form lives in
`data-models/hobo/schematools/v1/codegen_report.proto` with CUE constraints in
`data-models/codegen_report.cue`.

## Position in the event architecture

This package is build-time tooling: it hosts no actor, appends nothing to an
event store, and serves no runtime read store. A codegen run is a deterministic
command; the checked-in `src/_generated/` trees are the snapshot the drift gate
compares against, `--check` folds tree-vs-regenerated output into a drift
projection, and CI consumes the report envelope as a pipeline fact.

Preflight checks the local buf template before resolving/downloading CUE, so a
missing template fails immediately without requiring network or toolchain setup.
The CUE lane needs the pinned v0.14.0 binary on PATH or in the documented local
cache. A missing binary is a setup failure, not a passing schema check.
`test/cli-error-paths.test.ts` and `test/cue-helpers-and-formatting.test.ts` pin
preflight diagnostics and JSON error envelopes; `test/codegen-pipeline.test.ts`
exercises real generation, drift checks, and valid/invalid CUE fixtures.
