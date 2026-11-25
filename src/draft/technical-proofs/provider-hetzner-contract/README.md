# HOBO-169 Hetzner Provider Contract POC

This draft pins the `@hobo/provider-hetzner` provider-package contract for the
cheap self-host substrate in the seed provider set.

It proves:

- provider factory, scoped `.with(...)` builders, Capability Manifest, and default Resource Definitions
- provider-owned equivalence entries for the default definitions
- `realize()` emission as an `IacProgram` tagged for Terraform `hcloud` and Pulumi `hcloud`
- conformance coverage for claimed `compute`, `networking`, `volume`, and `objectStore` ports
- fixture realization of a server, private network/firewall, attached volume, and S3-compatible bucket
- `database{postgres,managed,require}` fail-closed behavior
- `database{postgres,managed,prefer}` degradation to container Postgres with a `PlanWarning` and `PortabilityReport` entry
- S3-compatible object-store divergence rejection
- HKE/k3s/Talos substrate readiness gating before workload placement
- vSwitch/firewall/volume ordering before server attachment

Out of scope per HOBO-169:

- wasmCloud-on-k8s runtime host implementation
- Crossplane/k8s IaC backend implementation
- real Hetzner API calls or kube-hetzner/Talos recipe depth
- other cloud providers

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\provider-hetzner-contract test
```

Relevant design records:

- `docs/design/control-plane.md`: Hetzner seed provider, provider authoring, `realize()` emission, and provider-owned defaults
- `docs/design/architecture.md`: provider package placement and adapter layering
- `docs/design/adr/07-portability-extensibility.md#adr-0024`: portability conformance guarantee and seed provider set


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Hetzner Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
