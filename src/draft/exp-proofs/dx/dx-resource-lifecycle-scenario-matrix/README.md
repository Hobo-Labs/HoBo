# DX resource lifecycle scenario matrix

This package proves `HOBO-567`: the first canonical DX matrix for deploying,
managing, inspecting, migrating, rolling back, and handing off HoBo resources.
It is intentionally a fixture contract, not production CLI, SDK, API, MCP, or UI
implementation.

## Scenario boundary

The matrix covers seven callers:

- app developer
- platform engineer
- GitOps
- SecOps
- DevOps
- SRE
- agent/MCP caller

Every caller row names the CLI commands, SDK calls, API calls, MCP tools,
expected artifacts, proof mode, fixture requirements, and the five required
paths: happy path, blocked path, stale or unknown evidence, migration or
rollback, and support handoff.

## Contract anchors

- Protobuf: `architecture/dx_resource_lifecycle_scenario_matrix.proto`
- CUE constraints: `architecture/dx_resource_lifecycle_scenario_matrix.cue`
- Pact-style fixture: `architecture/pacts/dx_resource_lifecycle_scenario_matrix.pact.json`
- Executable acceptance: `test/dx-resource-lifecycle-scenario-matrix.test.ts`

The TypeScript parser is the single runtime boundary for this proof. Downstream
proof packages consume `parseDxResourceLifecycleScenarioMatrix` and receive a
branded parsed object, not raw fixture data.

The Pact fixture and CUE constraints use the same lower-camel protobuf JSON
field shape as the TypeScript parser (`targetPackage`, `sdkCalls`,
`scenarioPaths`, and related fields) so downstream proof consumers do not need
parallel schema adapters.

## Scope guard

`classifyDxScenarioScope` fails closed for the issue's adversarial scope-out
cases:

- production CLI/API/SDK implementation
- live providers or real credentials
- customer data
- visual mockups that invent resource behavior before the matrix exists

## Verification

```bash
pnpm run test:file src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix/test/dx-resource-lifecycle-scenario-matrix.test.ts
```

This is the focused acceptance lane for the proof package. The branch-level
evidence also runs the repo architecture, standards, docs, traceability, and
staged agent checks.
