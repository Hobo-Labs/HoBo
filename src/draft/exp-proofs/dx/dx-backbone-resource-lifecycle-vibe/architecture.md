# Architecture Evidence

HOBO-566 is a coordination contract over experience proof slices.

- **Protobuf:** `architecture/dx_backbone_resource_lifecycle.proto` defines the
  backbone record, child slices, proof modes, and downstream consumer gates.
- **CUE:** `architecture/dx_backbone_resource_lifecycle.cue` constrains the
  closed proof-mode vocabulary, target package/proof-note shape, and M1/M2
  sequencing.
- **PACT:** `architecture/pacts/dx-backbone-resource-lifecycle.pact.json`
  captures the consumer expectation that downstream artifacts consume HOBO-577
  quickstart evidence and do not invent behavior.
- **Parse, don't validate:** `parseDxBackboneRecord` turns an untrusted record
  into the parsed derived type `ParsedDxBackboneRecord` before sequencing and
  downstream-gate checks. Consumers accept the parsed derived type instead of
  re-checking raw DTO fields.
- **Event architecture:** this proof does not introduce new production events.
  It names the command, event, actor, event-store, materialized view/projection,
  snapshot, and read store behavior that downstream resource lifecycle slices
  must preserve:
  - Command family: `dxBackbone.acceptGraph` accepts the static HOBO-566
    backbone graph; `dxBackbone.rejectScopeCreep` rejects requests that ask for
    production CLI/API/SDK, live providers, real credentials, customer data, or
    launch claims.
  - Event family: no new runtime events are emitted by this proof. Downstream
    work must map to existing `deployment.*`, `set.*`, `delta.*`, `resource.*`,
    `run.*`, `migration.*`, and `policy.Decided` event families.
  - Actor behavior: no production actor is implemented here. ResourceActor,
    Gatekeeper, CLI, SDK, and MCP actors consume the accepted graph as design
    evidence only.
  - Event-store behavior: no event-store writes happen in this proof. Future
    implementations append the design-doc event families under their own issues.
  - Materialized view / projection behavior: downstream docs, transcripts, and
    quickstarts project the accepted child-slice graph into visible examples.
  - Snapshot behavior: the frozen `ParsedDxBackboneRecord` is the deterministic
    snapshot used by tests and proof notes.
  - Read store behavior: the proof has no durable read store; consumers read the
    proof README, Pact fixture, protobuf/CUE contract, and traceability row.
