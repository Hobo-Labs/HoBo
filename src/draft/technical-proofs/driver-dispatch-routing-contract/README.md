# HOBO-97 Driver Dispatch Routing Contract

Independent POC for the control-plane Driver dispatch seam.

## What It Pins

- A resolved Resource Definition selects exactly one Driver id:
  `terraform`, `template`, `echo`, `container`, or `custom-webhook`.
- Managed drivers route through the existing Executor seam and emit `exec.*`
  plus `resource.Provisioned`.
- Driver outputs are captured on `resource.Provisioned` and resolved into
  dependent placeholder values.
- `echo` is read-only: declared connection info passes through without an
  Executor provision.
- `echo` refresh records a read-only drift hook without calling a Driver.
- Unknown driver ids fail before dispatch.
- Manifests without an `outputs` object fail closed before `resource.Provisioned`.
- `custom-webhook` timeouts classify as retryable `resource.Failed`.
- `destroy` and optional `refresh` route to the same selected driver with state.

## Scope Boundaries

This package does not implement Terraform, Pulumi, template rendering,
container provisioning, custom-webhook transport, Firecracker internals,
per-resource IaC state, or the ResourceActor reconcile loop. It proves the
routing contract those implementations consume.

## Run

```powershell
npm.cmd --prefix src\draft\technical-proofs\driver-dispatch-routing-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Driver Dispatch Routing Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
