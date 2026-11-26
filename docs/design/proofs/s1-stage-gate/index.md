# HOBO-615 S1 Stage Gate Proof

Draft POC at
[`src/draft/technical-proofs/s1-stage-gate`](../../../../src/draft/technical-proofs/s1-stage-gate/README.md)
wires the Stage 0/1 gate while S1 dependency slices remain in review. Promotion target:
`examples/hello-bindle` + `@hobo/runtime-local` once S1-04..S1-24 merge.

## Gate Statement

> **Stage 0/1:** the local Camp (`runtime-local`) passes runtime-port conformance;
> hello-bindle runs offline; replay == live.

(`docs/archive/requirements/requirements.md`, Release criteria)

## Requirements Mapping

| Requirement | Gate check | Evidence |
|---|---|---|
| FR-003 | offline + replay | workflow + actor + compensated saga complete; replay == live |
| FR-011 | offline-hello-bindle | `hobo dev` loop boots offline with zero credentials |
| NFR-002 | offline-hello-bindle | cold boot `duration_ms <= 60000` |
| NFR-011 | replay-equals-live | per-stream seq vector; tampered log raises `ReplayLiveMismatchError` |

## Standing Lane

The `S1 Stage Gate` workflow (`.github/workflows/s1-stage-gate.yml`) must stay green on PRs,
`main` pushes, and the weekly schedule. S2 cloud-deploy issues depend on this gate.

## Workflow Runs

Green on PR #677 (`8c2f60e`):

- [S1 Stage Gate workflow](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/28555660256)
- [conformance](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/28555660256/job/84662422575)
- [offline-hello-bindle](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/28555660256/job/84662422572)
- [replay-equals-live](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/28555660256/job/84662422560)
- [record](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/28555660256/job/84662492898)

## Sample Record

```json
{
  "gate_id": "s1-stage-gate",
  "commit_sha": "local",
  "workflow_run_url": "",
  "recorded_at": "2026-07-01T00:00:00.000Z",
  "checks": [
    {
      "check_id": "runtime-port-conformance",
      "status": "pass",
      "duration_ms": 12,
      "report_ref": "hobo.runtime-port-conformance/v1"
    },
    {
      "check_id": "offline-hello-bindle",
      "status": "pass",
      "duration_ms": 1500,
      "report_ref": ".hobo/offline-timing.json"
    },
    {
      "check_id": "replay-equals-live",
      "status": "pass",
      "duration_ms": 5,
      "report_ref": ".hobo/events.jsonl"
    }
  ]
}
```

## Verification

```bash
pnpm gate:s1
pnpm --prefix src/draft/technical-proofs/s1-stage-gate run gate:s1:offline
pnpm --prefix src/draft/technical-proofs/s1-stage-gate run gate:s1:replay
pnpm --prefix src/draft/technical-proofs/s1-stage-gate run gate:s1:conformance
```

## Promotion Notes

| Issue surface | Draft POC name | Production target (post S1 merge) |
|---|---|---|
| Conformance | `gate:s1:conformance` | `pnpm --filter @hobo/runtime-local run conformance` |
| Offline gate | `gate:s1:offline` | `pnpm --filter hello-bindle run gate:s1:offline` |
| Replay gate | `gate:s1:replay` | `pnpm --filter hello-bindle run gate:s1:replay` |
| Record parser | `parseStageGateS1Record` | `examples/hello-bindle/test/s1-stage-gate.record.ts` |
