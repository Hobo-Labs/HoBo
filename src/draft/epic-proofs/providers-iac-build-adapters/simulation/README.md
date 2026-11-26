# Providers/IaC/Build Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src/draft/epic-proofs/providers-iac-build-adapters run simulate
```

What this proves:

- Provider packages register default Resource Definitions with conformance evidence.
- `realize()` emits mocked `IacProgram` and `BuildSpec` objects consumed by mocked IaC/build/driver adapters.
- Drift, partial apply, and malicious-provider paths fail closed.
- The same multi-cloud shop Bindle remains unchanged across AWS and Azure fixtures.

Mocked boundaries:

- Provider registry, conformance gate, equivalence catalog, manifest registry, IaC adapters, build adapters, driver taxonomy, drift/import refresh, generation sandbox, resource-pack distribution, and execution-host dispatch.

Contracts:

- `../contracts/pact-inventory.md`
- `../contracts/pacts/*.pact.json`
