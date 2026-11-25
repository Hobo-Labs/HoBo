# Intent-alignment iteration 2 — Architecture Evidence

Schema and event vocabulary for the GAPS register contract proof (HOBO-691).

## Schema And Constraints

- Protobuf: [`architecture/intent_alignment_iter2_contract.proto`](./architecture/intent_alignment_iter2_contract.proto)
- CUE: [`architecture/intent_alignment_iter2_contract.cue`](./architecture/intent_alignment_iter2_contract.cue)
- PACT: [`architecture/pacts/intent_alignment_iter2_contract.pact.json`](./architecture/pacts/intent_alignment_iter2_contract.pact.json)

## Parse, Don't Validate

`validateIteration2Register` parses raw GAPS markdown once at the boundary into a
`ValidationResult` derived type; callers never re-scan partial register fragments.

## Event Architecture

- **Command** — `RecordIteration2Review` (append iteration log + register rows)
- **Event** — `IntentAlignmentReviewRecorded`
- **Actor** — gap-review register aggregate
- **Event store** — GAPS.md iteration log (append-only register)
- **Projection** — gap/drift register tables + REM remediation sections
- **Snapshot** — current `ValidationResult` from contract test
- **Read store** — proof test reads repo-root GAPS.md snapshot

No runtime engine implemented; design-time contract only.
