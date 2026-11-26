# @hobo/schema-tools — Architecture Evidence

The production protobuf/CUE codegen orchestrator (ADR-0037 codegen surface),
promoted from the `s0-04-protobuf-cue-codegen` draft proof (frozen in
`scripts/promotions.json`). It wraps `buf generate` (protoc-gen-es, template
`buf.gen.yaml`) and `cue vet` over each opted-in package's
`data-models/fixtures/{valid,invalid}/*.json`.

A package opts into codegen by giving its `data-models/` a `buf.yaml`
module marker; outputs land in the package's checked-in `src/_generated/`
(`hobo codegen --check` is the drift gate). Discovery covers
`packages/*/data-models` and nested category packages
(`packages/{adapters,providers,runtimes,iac,build}/*/data-models`; `adapters/` was missing
until the OpenSesame adapter, the first adapter to opt in, needed it).

## Schema and constraints

- Protobuf records live in
  [`data-models/hobo/schematools/v1/codegen_report.proto`](./data-models/hobo/schematools/v1/codegen_report.proto)
  (the codegen report envelope).
- CUE constraints bound every protobuf type in
  [`data-models/codegen_report.cue`](./data-models/codegen_report.cue),
  vetted against the fixtures under `data-models/fixtures/`.
- PACT boundary evidence for the CI report envelope lives under
  [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

CLI argv crosses one parser boundary (`parseCodegenArgv`) and becomes the
frozen derived type `CodegenInvocation`; downstream code receives parsed
invocations, never raw argv. The report envelope is a derived parsed type
(`createCodegenReport`) whose JSON form is itself `cue vet`-validated.

## Event architecture

The codegen run is a deterministic build-time command; its report rides the
platform's event model rather than defining a new one:

- **Command** — `RunCodegen` / `CheckCodegen` (write vs drift-check modes).
- **Event** — the CI schema gate consumes the report envelope as a
  `pipeline.*`-family fact; drift entries are the event payload.
- **Actor** — the CI fabric's schema-gate job owns invocation; the tool
  itself is stateless.
- **Event store** — reports append to CI run history (workflow artifacts);
  generated outputs are snapshotted in git.
- **Materialized view / projection** — `codegen --check` folds the current
  tree against regenerated output into the drift projection.
- **Snapshot** — the checked-in `src/_generated/` tree is the snapshot the
  drift gate compares against.
- **Read store** — editors and builds read the checked-in generated types
  with no build step (ADR-0037).
