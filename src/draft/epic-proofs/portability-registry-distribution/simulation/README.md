# Simulation Harness

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\portability-registry-distribution run simulate
```

What this proves:

- Certified install is available to Matching but never selected automatically.
- Agent discovery and version resolution freeze a deterministic digest pin.
- Mirror cost selection runs only after verified digest identity.
- Catalog, trust, yank, and offline import gates fail closed.

Mocked boundaries:

- Artifact repository mirror: in-memory digest-pinned mirrors.
- Capability discovery index: in-memory lifecycle projection.
- Trust/policy gate: deterministic fixture keys and policies.
- Offline import: in-boundary mirror and zero-egress trap.

Contracts:

- `../contracts/pacts/registry-artifact-repository.pact.json`
- `../contracts/pacts/registry-capability-discovery.pact.json`
- `../contracts/pacts/registry-trust-policy.pact.json`
- `../contracts/pacts/registry-offline-import.pact.json`
