# CLI, MCP & Developer Experience Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\cli-mcp-developer-experience run simulate
```

What this proves:

- The canonical CLI command registry and MCP tool specs remain parity-checked.
- App developer, GitOps, SecOps, SRE, and DevOps journeys run through deterministic mocked boundaries.
- SVID-bound MCP, credential redaction, local fidelity, operations manifests, and role-flow gates fail closed.

Mocked boundaries:

- CLI command path: in-process POC command handlers.
- MCP control surface: fixture SVID verifier and in-memory audit sink.
- Runtime projection: fixture project, dev loop, plan/up, inspect/logs, doctor, and event streams.
- Identity/policy: in-memory credential store, OIDC/STSes, policy decisions, and token audit events.
- Operations manifest: in-memory generated manifests.

Contracts:

- `../contracts/pacts/cli-command-path.pact.json`
- `../contracts/pacts/mcp-control-surface.pact.json`
- `../contracts/pacts/runtime-projection-boundary.pact.json`
- `../contracts/pacts/identity-policy-boundary.pact.json`
- `../contracts/pacts/operations-manifest-boundary.pact.json`
