# Networking Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\networking-connectivity-dns-relay run simulate
```

What this proves:

- Cross-cloud bind selects tier 3, enforces policy, validates mTLS, and emits Junction halves.
- Custom-domain promotion uses shadow DNS, validation gates, ACME, gateway routing, and rebinding/split-horizon failure paths.
- Relay attaches outbound-only and denies private-network abuse cases.
- Tenant ingress resolves `ctx.tenant` before handlers and blocks mismatch.

Mocked boundaries:

- DNS shadow port: in-memory adapter.
- Certificate authority: fixture identity CA plus private ACME endpoint.
- Gateway traffic router: gateway realization module with deterministic health.
- Relay private executor: contract module with fixture target.
- Tenant claims: deterministic routing table and JWT fixture.

Contracts:

- `contracts/pacts/connectivity-tier-selector.pact.json`
- `contracts/pacts/connectivity-policy-gate.pact.json`
- `contracts/pacts/identity-mtls-data-path.pact.json`
- `contracts/pacts/yard-topology-manifest.pact.json`
- `contracts/pacts/junction-connectivity-planner.pact.json`
- `contracts/pacts/dns-shadow-port.pact.json`
- `contracts/pacts/domain-validation-gate.pact.json`
- `contracts/pacts/certificate-authority.pact.json`
- `contracts/pacts/gateway-traffic-router.pact.json`
- `contracts/pacts/cost-routing-ledger.pact.json`
- `contracts/pacts/hobo-relay-private-executor.pact.json`
- `contracts/pacts/tenant-routing-claims.pact.json`
