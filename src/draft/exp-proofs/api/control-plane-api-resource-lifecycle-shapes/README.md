# Control-Plane API Resource Lifecycle Shapes

HOBO-569 proof for shared control-plane API shapes that CLI, SDK, dashboard,
and MCP callers consume for resource lifecycle work.

## What This Proves

- Every accepted operation has request and response shape examples for plan,
  apply/up, inspect, logs, import/adopt, migrate, rollback, and support
  evidence pack flows, including `GatekeeperDecision`, `DriftReport`,
  `ResourceActorState`, `LogCursor`, and `MigrationPhase`.
- Refusal envelopes fail closed for policy denied, contract incompatible,
  provider capability partial/none, stale projection, unknown evidence,
  non-reactive sink, and destructive migration blocked paths.
- Human CLI/API callers and agent MCP callers receive the same typed result
  envelope, proof mode, fixture id, correlation id, and redaction class.
- Contract evidence is package-local: protobuf data shapes, CUE constraints,
  and a Pact-style boundary fixture.
- Scope guards reject production API, persistence, provider, credential, and
  Planner/Gatekeeper bypass work.

## Audience And Friction

Primary audience is the platform engineer or agent author wiring resource
lifecycle tooling. They need one vocabulary for DeploymentPlan, Deployment Set,
Delta, Gatekeeper, ResourceActor, projection freshness, logs, import/adopt,
migration, rollback, and support evidence. The friction removed here is
interface drift: CLI, SDK, API, dashboard, and MCP examples all point at the
same typed result envelope instead of each surface inventing errors.

## Boundary

This package is an experience proof, not production implementation. It does not
build a REST server, CLI parser, SDK package, MCP server, persistence layer,
dashboard, provider adapter, cloud call, credential flow, live support system,
or customer-data path.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\control-plane-api-resource-lifecycle-shapes test
```

## Architecture Evidence

- `architecture/control_plane_api_resource_lifecycle_shapes.proto` defines the
  boundary data shapes.
- `architecture/control_plane_api_resource_lifecycle_shapes.cue` constrains the
  lower-camel protobuf JSON shapes consumed by the parser.
- `architecture/pacts/control_plane_api_resource_lifecycle_shapes.pact.json`
  pins a Pact-style API/MCP parity boundary with the full parsed contract body.
- `ARCHITECTURE.md` records parse-don't-validate and event architecture
  evidence.
