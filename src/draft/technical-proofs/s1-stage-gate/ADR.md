# S1 Stage Gate — Architecture Evidence

Draft POC for HOBO-615. Wires three standing checks without inventing a new service
boundary; consumes existing draft proofs for conformance, dev loop, and replay equivalence.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/stage_gate_record.proto`](./architecture/stage_gate_record.proto).
- CUE constraints in [`architecture/stage_gate_record.cue`](./architecture/stage_gate_record.cue) pin
  `gate_id`, the three `check_id` values, green-only status, and `offline-hello-bindle.duration_ms <= 60000`.
- PACT contract in [`architecture/pacts/s1_stage_gate.pact.json`](./architecture/pacts/s1_stage_gate.pact.json).

## Parse, Don't Validate

`parseStageGateS1Record` is the only entry for raw gate JSON. Downstream code receives
parsed derived types (`StageGateS1Record`, `StageGateCheck`) instead of re-checking raw input.

## Event Architecture

The offline gate exercises a small event-sourced flow:

- **Command** — run workflow checkout, actor signal, and saga compensation probe.
- **Event** — append `workflow.Completed`, `actor.SignalHandled`, and `saga.*` events to the event store.
- **Actor** — inventory actor handles the signal command and emits actor events.
- **Event store** — append-only `.hobo/events.jsonl` is the durable source of truth.
- **Materialized view / projection** — replay folds the log into gate state for the replay check.
- **Snapshot** — `.hobo/offline-timing.json` records boot timing for the gate record.
- **Read store** — tests query folded replay state and timing artifacts, not mutable in-process state.

No runtime engine is implemented here; this package names the command, event, actor, projection,
snapshot, and read-store boundaries the production gate inherits.
