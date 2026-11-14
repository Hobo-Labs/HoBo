# `@hobo/fleet-agent`

What a HoBo Fleet device needs beyond the domain (ADR-0183): key stores, sandbox
drivers, the per-order egress proxy, host capacity and service installers. A
library; it has no binary. `hobo fleet run` and the box worker compose it with
`createFleetAgent` from `@hobo/fleet/agent`.

Design: [HoBo Fleet](../../docs/design/fleet.md) and
[ADR-0183](../../docs/design/adr/fleet.md#adr-0183); operating it:
[the fleet runbooks](../../docs/maintenance/fleet/index.md).

## Entry points

| Entry point | Does |
|---|---|
| `createFileKeyStore`, `createExternalSignerKeyStore` | A `KeyStore` in a private directory, or behind an external signer command |
| `createHostCapacity` | A `CapacitySource` for this host's slots, memory and disk |
| `installService` | Installs `hobo fleet run` as a systemd unit, launchd agent or Windows service |
| `sandboxDrivers` | The sandbox drivers whose self-test passed, up to a tier cap |
| `createEgressProxyFactory` | One egress proxy per order, exact hosts only |

## Parts

Each part has its own README next to its code.

- **Key stores** — [`src/keystore/README.md`](src/keystore/README.md).
  `createFileKeyStore` (EC P-256 identity, Ed25519 `SIGN`, X25519 `SEAL`, tier
  `T0`) and `createExternalSignerKeyStore` (identity key behind a helper
  command speaking `public`, `sign` and `destroy`, tier `T1`). The key
  directory is refused inside a git checkout or when others can read it.
- **Host capacity** — [`src/capacity/README.md`](src/capacity/README.md).
  Slots, `MemAvailable` less the 2 GiB worker reserve, and `statfs` disk; an
  unreadable figure is left out, never zero.
- **Service installers** — [`src/install/README.md`](src/install/README.md).
  A systemd user unit, a launchd agent, or a Windows Task Scheduler task; the
  caller enables it.
- **Sandbox drivers** — [`src/sandbox/README.md`](src/sandbox/README.md).
  `S1` over `crun`/`runc` with bundles the driver writes, `S2` over gVisor
  `runsc`; the `S3` drivers (Kata, Apple `container`) fail their self-test
  closed until the vsock path is built (A11, A12).
- **Egress proxy** — [`src/egress/README.md`](src/egress/README.md).
  One proxy per order, exact hosts only, the fleet allowlist read on every
  request, loopback, link-local, metadata and multicast always refused.

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
- **Sandbox runtime (D58):** the agent provisions gVisor `runsc` itself (pinned
  release, SHA-512 checked, cached), so no host `crun`, `runc` or `nsenter` is
  needed. `fleet-agent-sandbox-provision [--cache <dir>] [--probe]` runs the
  same provisioning and privilege probe for CI and operators, and prints the
  mode (`rootful`, `rootless` or `unavailable`). O10's fallback (A10) names this
  runtime in `scripts/fleet-outcome.mts`.

## Architecture placement

A library at layer 3. It handles no command and emits no events: the agent
(`@hobo/fleet/agent`) is the actor and the authority's event store holds the
history. Its only state is the device's key store and agent state file, written
by atomic replace; it keeps no projection, materialized view, snapshot or read
store.
