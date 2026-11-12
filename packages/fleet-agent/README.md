# `@hobo/fleet-agent`

What a HoBo Fleet device needs beyond the domain (ADR-0182): key stores, sandbox
drivers, the per-order egress proxy, host capacity and service installers. A
library; it has no binary. `hobo fleet run` and the box worker compose it with
`createFleetAgent` from `@hobo/fleet/agent`.

## Entry points

| Entry point | Does |
|---|---|
| `createFileKeyStore`, `createExternalSignerKeyStore` | A `KeyStore` in a private directory, or behind an external signer command |
| `createHostCapacity` | A `CapacitySource` for this host's slots, memory and disk |
| `installService` | Installs `hobo fleet run` as a systemd unit, launchd agent or Windows service |
| `sandboxDrivers` | The sandbox drivers whose self-test passed, up to a tier cap |
| `createEgressProxyFactory` | One egress proxy per order, exact hosts only |

Until each lane lands, its entry point has its final signature and throws
`FleetNotImplemented`.

## Gates

- **TypeScript:** `pnpm --filter @hobo/fleet-agent run build`.
- **Protobuf + CUE:** `data-models/fleet_agent.proto` holds the device's local
  settings and `fleet_agent.cue` constrains them. Parse, don't validate: the
  settings, keys read from disk and capacity readings are parsed derived types
  before the agent sees them.
- **PACT:** `contracts/` (a placeholder).
- **Conformance:** key stores pass `runKeyStoreConformance`; sandbox drivers pass
  `runSandboxConformance` and, where the runtime is provisioned,
  `runSandboxIsolationProbe`.

## Architecture placement

A library at layer 3. It handles no command and emits no events: the agent
(`@hobo/fleet/agent`) is the actor and the authority's event store holds the
history. Its only state is the device's key store and agent state file, written
by atomic replace; it keeps no projection, materialized view, snapshot or read
store.
