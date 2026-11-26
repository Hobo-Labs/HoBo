# HOBO-97 Driver Dispatch Routing Proof

This executable proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25),
and [ADR-0006](../../adr/01-architecture-core.md#adr-0006).

## Contract Surface

- A resolved Resource Definition routes to the named Driver id.
- Managed Driver provisions run through the Executor seam and record `exec.*`.
- Driver outputs flow into `resource.Provisioned` and dependent placeholders.
- `echo` resources pass declared connection info through without provisioning.
- `echo` refresh records read-only drift observation without provisioning.
- Unknown Driver ids are rejected before dispatch.
- Manifests without outputs and custom-webhook timeouts fail closed as typed
  `resource.Failed` outcomes.
- `destroy` and optional `refresh` stay routed through the selected Driver.

## Proof Boundaries

This is a contract POC. It does not implement real provider/IaC backends,
Terraform/Pulumi/OpenTofu, template rendering, custom-webhook networking,
Executor sandbox internals, per-resource state backends, drift behavior, or the
ResourceActor reconcile loop.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\driver-dispatch-routing-contract test
```

The checks prove all five Driver ids at the dispatch seam, output capture,
dependent placeholder resolution, echo read-only behavior, unknown-id rejection,
manifest-without-output rejection, retryable custom-webhook timeout
classification, echo drift observation, and stateful `destroy` / `refresh`
routing.
