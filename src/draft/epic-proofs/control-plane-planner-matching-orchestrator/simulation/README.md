# Control Plane Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\control-plane-planner-matching-orchestrator run simulate
```

What this proves:

- Deterministic planning and Matching over a fixture manifest/catalog.
- Delta-to-Set reconciliation through ResourceActor, Executor, and Driver boundaries.
- Drift, partial-realize rollback, orphan sweep, and dispatcher reservation hardening.
- Self-host seed Yard handover with no live Identity or provider calls.

Mocked boundaries:

- Manifest collector: fixture manifest response.
- Resource Definition catalog: stable catalog hash and match candidates.
- Capability registry: support matrix and remediation.
- Objective ledger: pinned CreditLedgerView.
- Gatekeeper: contract/policy/eval decision.
- Deployment Set store: immutable Set refs.
- EventStore/ActorHost: in-memory actor transcript.
- Executor sandbox: Firecracker-shaped response.
- Driver adapter: driver taxonomy response.
- Drift refresh: drift/orphan evidence.
- Identity token broker: redacted short-lived token descriptor.
- Bootstrap handover: seed-to-real Identity transcript.
- DeploymentView projection: correlation graph.

Contracts:

- `contracts/pacts/*.pact.json`
