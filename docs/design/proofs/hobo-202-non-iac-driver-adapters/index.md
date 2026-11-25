# HOBO-202 Non-IaC Driver Adapters Proof

This executable proof backs [PLAN-04](../../control-plane.md#plan-04) and
[PLAN-25](../../platform-engineering.md#plan-25).

## Contract Surface

- `template` renders a fixture Kubernetes manifest set from Resource Definition `.with.manifests`.
- `template` rejects unresolved placeholders before returning manifests or outputs.
- `echo` passes declared connection outputs through without provisioning.
- `echo` refresh reports read-only drift and rejects mutation attempts by default.
- `container` runs a fixture provisioning script through a sandboxed Executor seam.
- `container` denies egress outside the scoped sandbox target before dispatch.
- `custom-webhook` sends signed SVID requests and returns fixture service outputs.
- `custom-webhook` rejects invalid or forged SVID signatures.
- Resource Definitions select `template`, `echo`, `container`, and `custom-webhook` by driver id.
- Managed adapter outputs compose with the dispatch router as `resource.Provisioned` events and
  dependent placeholder values.

## Proof Boundaries

This is a contract POC. It does not implement the Driver port type, real Firecracker execution,
production sandboxing, real HTTP transport, IaC drivers, `hobo import`, external-resource runtime
kinds, or ResourceActor reconciliation. Those remain separate control-plane, provider, executor,
networking, and lifecycle slices.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\non-iac-driver-adapters-contract test
```

The checks prove the four non-IaC adapters, Resource Definition selection, output return paths,
dispatch event/placeholder composition, and the adversarial fail-closed cases for read-only echo,
unsigned webhook requests, sandbox egress, and unresolved template placeholders.
