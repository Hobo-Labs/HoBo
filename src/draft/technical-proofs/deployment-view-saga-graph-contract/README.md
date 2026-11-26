# DeploymentView Saga Graph Contract POC

Independent POC for HOBO-382. It pins the GA `DeploymentView` projection that
reconstructs a deployment saga graph from control-plane events keyed by
`correlationId`.

## Acceptance Evidence

- Replaying a fixture deploy event stream reconstructs nodes, dependency edges,
  per-node state, and the timeline from events only.
- The projection exposes per-resource `match.Decided` rationale so "why this
  infra" is available on each node.
- `createInspectRunQuery` reads the event store by correlation id and never
  calls a provider client.
- Missing `correlationId` or `causationId` fails the end-to-end assertion.

## Adversarial Evidence

- Out-of-order delivery converges by sorting on event sequence.
- Concurrent deployments are isolated by `correlationId`.
- A partially rolled-back deployment shows the compensation state and rollback
  subgraph.
- An incomplete deployment renders as `in-flight` with `partial: true`.

## Scope

This proof stops at the projection/query contract. It does not implement the
dashboard UI, realtime Streamer push, provider reads, or cross-deployment fleet
rollups.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\deployment-view-saga-graph-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Deployment View Saga Graph Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
