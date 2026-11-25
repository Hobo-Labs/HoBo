# @hobo/stage-gate — Architecture Evidence

S0-12 production package. Reusable stage-gate runner that executes ordered
toolchain checks, captures evidence, and emits an append-only `StageGateRecord`.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that folder.
- PACT consumer evidence lives under [`contracts/`](./contracts), including the
  ai-bdd process boundary (`stage-gate-ai-bdd-report.pact.json`, one interaction
  per exit code of `compile --check`, `run` and `verify-run`; ADR-0172).

## Parse, don't validate

Untrusted JSON crosses one parser boundary via `parseStageGateRecord`. The
parser applies protobuf shape plus CUE constraints and returns deep-frozen
derived types (`StageGateRecord`, `CheckResult`, `ComponentArtifact`,
`SignatureEvidence`). Downstream code and acceptance surfaces only consume
parsed records; malformed or tampered input throws `StageGateParseError`.
Records and check output are narrowed through the tag guards in `src/json.ts`
(own fields only, so a key named like an `Object.prototype` member reads as
absent), never through `typeof`; `serializeStageGateRecord` returns the named
`StageGateRecordJson` wire form, which goes back through the parser unchanged.

Check execution resolves `pnpm` through a non-repo-local Windows executable or
the prepared Corepack shim and records spawn errors plus failure output tails in
check evidence, so cross-platform S0 failures remain diagnosable and fail
closed instead of producing empty evidence.

## Event architecture

- **Command** — `hobo-stage-gate run <gateId>` (`s0` or `release`) requests a full gate execution.
- **Event** — each check completion appends a `CheckResult` to the run record.
- **Actor** — CI workflow or local runner identity is captured in record metadata.
- **Event store** — gate records are append-only evidence; runs are never mutated.
- **Materialized view / projection** — `docs/design/build-s0-stage-gate-acceptance.md`
  projects the latest passed record into the gate table.
- **Snapshot** — the emitted `stage-gate-s0.record.json` is the current-run snapshot.
- **Read store** — acceptance docs and CI artifacts read from stored gate records.

No durable event engine is implemented here; this package orchestrates checks and
serializes the evidence envelope other surfaces consume.
