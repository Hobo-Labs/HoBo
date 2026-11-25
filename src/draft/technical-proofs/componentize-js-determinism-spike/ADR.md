# Componentize-js Determinism Spike — Architecture Evidence

HOBO-603 spike package. Records the relaxed S0 componentize stage gate in ADR-0105.

## Schema And Constraints

- Protobuf shapes: [`architecture/componentize_js_determinism_spike.proto`](./architecture/componentize_js_determinism_spike.proto)
- CUE constraints: [`architecture/componentize_js_determinism_spike.cue`](./architecture/componentize_js_determinism_spike.cue)
- PACT boundary: [`architecture/pacts/componentize_js_determinism_spike.pact.json`](./architecture/pacts/componentize_js_determinism_spike.pact.json)

## Parse, Don't Validate

`ComponentizeDeterminismFinding` and `ComponentizeStageGateDecision` are design-time
derived types. The spike's executable tests assert runtime findings match the CUE
constraints (`bytes_stable: false`, `require_byte_identical_wasm: false`).

## Event Architecture

- **Command** — `ComponentizeDeterminismInvestigationRequested`
- **Event** — `ComponentizeStageGateRelaxed` (append-only; cites ADR-0105 rationale)
- **Actor** — toolchain investigation actor emits the decision event
- **Event store** — durable investigation log
- **Projection** — spike README + ADR-0105 read model
- **Snapshot** — `ComponentizeStageGateDecision` returned by tests
- **Read store** — design docs and HOBO-584 acceptance cross-links

No runtime event store is implemented; this names the boundaries for promotion.
