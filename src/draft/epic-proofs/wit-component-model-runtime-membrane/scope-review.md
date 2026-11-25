# WIT Runtime Membrane Scope Review

The review accepted only behavior that strengthens the epic's runtime contract. It rejected live infrastructure, real Wasmtime/wasmCloud execution, cloud networking, and production provider adapters.

## Decisions

| Question | Decision |
|---|---|
| Requirement proved | One WIT contract surface can drive local, cross-process, cross-host, runtime-port, websocket, and conformance flows. |
| Persona | App developer, platform operator, SDK maintainer, runtime operator. |
| BDD scenario | Four scenarios in the README and tests. |
| Vertical slices | runtime-local durable workflow; portable wRPC membrane; SDK/capability parity; host portability and upgrade. |
| Service boundaries | Nine boundaries in the architecture map and Pact inventory. |
| Pact strategy | Consumer fixtures for every boundary; providers remain deterministic mocks until real providers exist. |
| Kept from POCs | Pure contract functions, event names, fail-closed error codes, conformance reports, version pins, and mocked provider seams. |
| Discarded from POCs | One-off package internals, test-only harness details, live infrastructure assumptions, and PR-specific traceability conflicts. |
| Edge cases | Missing grants, stale fences, below-floor links, exceeded deadlines, overload, missing upcasters, and semantics-annex failures. |
| Conflict risk | Runtime-port conformance PR #180 remains unmerged; this reference consumes its accepted behavior as evidence and does not copy its unmerged implementation. |
| Simulation risk | A misleading simulation would imply real Wasmtime/wasmCloud/NATS execution; docs and fixture names keep those mocked. |
| Contract brittleness risk | Pacts assert consumer-visible request/response shapes, not broad implementation internals. |
| Cross-epic scope | Providers, Identity, CLI/MCP, Data Plane projections, and Progressive Delivery consume these boundaries but remain outside this rollup. |

## POC Review Notes

- HOBO-12/15/16/33/36 define versioned contract identity and upgrade policy; they belong in the contract plane.
- HOBO-17/28/29/35/400 define host selection and conformance; they belong in the host plane.
- HOBO-18/24/25/26/27 define link behavior and failure taxonomy; they belong in the link plane.
- HOBO-20/21/22/23/30 define durable runtime ports; they belong in the runtime-port plane.
- HOBO-19/31/32/34 define capability and SDK conformance edges; they belong in the parity/security slice.
