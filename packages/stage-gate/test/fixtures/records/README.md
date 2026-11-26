# Record fixtures for `cue vet -c`

`test/record-cue.test.ts` (the package's `test:schema`) vets every file here
against `data-models/stage_gate_record.cue` and `acceptance_evidence.cue`:
`<Definition>/valid/*.json` must pass and `<Definition>/invalid/*.json` must be
refused. `parseStageGateRecord` must agree on each `StageGateRecord` file.

- `StageGateRecord/valid/release-passed.json` and `release-not-run.json` are the
  records `runStageGate(defineReleaseGate())` wrote against
  `test/helpers/fake-ai-bdd.mts` (exits 0 and 3), with the node path and the
  temporary project directory replaced by `node` and `/work/project`.
- `StageGateRecord/valid/s0-passed.json` is the passed S0 record of
  `test/parse.test.ts` in the runner's wire form.
- Each `invalid/` file is a valid record with one thing removed or changed, as
  its name says. Four are the round-2 review's records that CUE accepted while
  its fields were not marked required (`release-intact-without-evidence`,
  `release-intact-empty-evidence`, `release-replay-without-model-calls`,
  `release-replay-without-replay-only-flags`).
- `release-passed-total-leading-zero.json` (valid) and `release-replay-total-past-int64.json` and
  `release-replay-total-zero.json` (invalid) pin that the CUE reads `scenarios_total` as the parser does: decimal
  digits, a leading zero allowed (`strconv.Atoi`), within int64, above 0.
- `AcceptanceEvidence/valid/passed.json` is what `parseAiBddRunReport` reads from
  `../ai-bdd/report.v1.passed.json`, in snake case; the test checks it still is.
