# Provider Port Contract POC

Independent POC for HOBO-47. It pins the M0 contract shape between the Yard control plane and provider/IaC adapters without implementing any concrete cloud, IaC engine, build engine, or runtime client wiring.

## Contract Surface

- `Capability`: owns a WIT port name, supported verbs, `satisfies(request) -> full|partial|none`, and optional `estimateCost`.
- `CloudProvider`: owns provider identity, regions, capabilities, `capabilityManifest()`, `realize(ResourcePlan) -> { iac, build? }`, and `client(port, outputs)`.
- `IacProvider`: owns `preview`, `apply`, `refresh`, and `destroy`, returning typed `Diff`, `Outputs`, and `DriftReport` records.
- `PortRequest`: carries `require` vs `prefer` strictness so a partial capability either rejects planning or degrades with a warning.

## Scope Boundaries

This POC does not implement concrete provider packages, Pulumi/Terraform/OpenTofu/Crossplane adapters, BuildProvider internals, or `ctx.bindings` runtime clients. It only proves the port contracts those later slices consume.

## Verification

```powershell
npm.cmd test
npm.cmd --prefix src\draft\technical-proofs\provider-port-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Port Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
