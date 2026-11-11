# @hobo/conformance — Architecture Evidence

Production conformance package. It preserves the S0-01 workspace-boundary
scaffold and adds the HOBO-585 port-suite harness for golden-IR capture, replay
comparison, deterministic seed checks, coverage manifests, provenance, and
claimed-port listing/blocking disposition.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that folder.
- PACT consumer/provider evidence lives under [`contracts/`](./contracts).

## Parse, don't validate

`parseWorkspaceEdge` and related helpers apply parse, don't validate at the
boundary: untrusted edge DTOs become derived parsed types before boundary
validation runs. CUE constraints on `WorkspaceEdgeRecord` and
`WorkspaceSkeletonValidatedEvent` reject malformed input at parse time.

## Event architecture

- **Command** — validate workspace skeleton imports and topology.
- **Event** — `WorkspaceSkeletonValidatedEvent` records the validation outcome.
- **Actor** — conformance harness actor applies validation commands.
- **Event store** — validation events append to the platform event store.
- **Materialized view / projection** — boundary violation list is the projection.
  Each violation carries the rule that raised it, from the closed
  `BOUNDARY_RULES` list (`#BoundaryRule` in the CUE). A refusal and its record
  are made together, so the list is every refusal the gate printed — including
  the three engine-neutrality rules (an orchestrator imports no data engine,
  no database driver and no engine-specific storage at runtime; engines do not
  import each other at runtime; test-only edges are allowed). See the README's
  "The workspace boundary gate".
- **Snapshot** — latest validated workspace rev is the read snapshot.
- **Read store** — CI and adapters query the read store for boundary status.

The harness implements parse/refinement tests; runtime projection is deferred to
later conformance slices.

The port-suite runner appends `conformance.RunStarted`,
`conformance.CaseChecked`, `conformance.CoverageEvaluated`, and
`conformance.RunCompleted` events; `projectPortSuiteReport` derives the
`PortSuiteReport` read model from that append-only log.

## S1-10 trust-boundary suites (HOBO-599)

Production suites under `src/suites/`:

- **runtime-port** — `hobo.runtime-port-conformance/v1` durability checks
  (EventStore, Queue, ActorHost, checkout replay==live). Parse boundary:
  `src/suites/runtime-port/parse.ts`.
- **component-host** — `@hobo/conformance/component-host/v1` cross-host
  portability assertions with manifest host pins. Parse boundary:
  `src/suites/component-host/parse.ts`.

Protobuf + CUE for both report shapes live in `data-models/runtime_port_conformance.*`
and `data-models/component_host_conformance.*`. PACT contracts under
`contracts/pacts/conformance-runtime-port-backend.pact.json` and
`conformance-component-host.pact.json`.

The checkout proof appends events and folds them — actors emit events via
ActorHost leases; replay-equals-live is asserted, not assumed.
