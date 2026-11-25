# HOBO-202 Non-IaC Driver Adapters Contract

Independent POC for the non-IaC Driver adapters in the provider taxonomy.

## What It Pins

- `template` renders a fixture Kubernetes manifest set from Resource Definition `.with.manifests`.
- `template` fails closed when a manifest references an unresolved placeholder.
- `echo` passes declared external connection outputs through without provisioning.
- `echo` refresh reports read-only drift and rejects mutation attempts by default.
- `container` calls a sandboxed Executor seam for a fixture provisioning script and returns outputs.
- `container` denies script egress outside the scoped sandbox target before the Executor runs.
- `custom-webhook` sends a signed SVID request to a fixture HTTP service seam and returns outputs.
- `custom-webhook` rejects invalid or forged SVID signatures.
- All four adapters are selectable by a Resource Definition `driver` id.
- Managed adapter outputs compose with the dispatch router as `resource.Provisioned` events and
  dependent placeholder values.

## Scope Boundaries

This package does not own the Driver port type, Executor/Firecracker implementation, real HTTP
transport, IaC drivers, `hobo import`, or the external resource kind. It proves concrete adapter
behavior behind the existing Resource Definition and Driver seams.

## Run

```powershell
npm.cmd --prefix src\draft\technical-proofs\non-iac-driver-adapters-contract test
```

Relevant design records:

- `docs/design/platform-engineering.md`: Driver taxonomy, Driver interface, `echo`, `template`,
  `container`, `custom-webhook`, scoped Executors, and placeholder outputs
- `docs/design/control-plane.md`: `IacProvider` as one Driver in the broader taxonomy


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Non Iac Driver Adapters Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
