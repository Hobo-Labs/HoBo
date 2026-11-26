# Reference adapters

These are small in-memory adapters, one per CD conformance suite. They are
deterministic: they take an injected clock and use no RNG and no network.
Each harness factory (`ref*Harness`) takes an optional `mutant`, which breaks
exactly one property of the port so you can watch the suite catch it.

| File | Harnesses |
|---|---|
| `ports.ts` | Realizer, TrafficShifter, HealthSource, PublisherPort, ReconcilerTransport, ArtifactStore, ArtifactVerifier, ProvenanceVerifier, SubscriptionDriver |
| `fleet.ts` | PlacementEngine, FanoutController, PostureEvaluator, CampInventory |
| `matrix.ts` | Toolset matrix, platform matrix, air gap, journal replay |
| `chaos.ts` | Chaos world (six faults) and the fan-out load world |
| `common.ts` | Clock, context, typed refusals, sha256 |

The references model each port at its boundary and nothing more. They are
not `@hobo/cd`. The composed system (`composeContinuousDelivery`) binds the
same harness interfaces.

## Runbook

- **Add a mutant** when you find a new way an adapter can break a port.
  Add a matching row to the `it.each` table in the test for that suite. If
  no assertion catches the new mutant, the suite has a gap. Close it in
  `packages/conformance/src/suites/cd-*.ts`.
- **Change a reference** only to follow a change in the frozen port. A
  reference that passes because the suite went soft proves nothing.
