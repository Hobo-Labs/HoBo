# @hobo/iac-opentofu backend contract

Independent proof for HOBO-186. The package models `@hobo/iac-opentofu`
as an `IacProvider` adapter over a pinned OpenTofu binary seam, consuming the
same fixture resource shape used by the `iac-pulumi` proof.

## Proven behavior

- `preview(program)` returns an OpenTofu `Diff` for the fixture IacProgram.
- `apply(program)` provisions the fixture resources and returns Outputs plus
  stack outputs for binding resolution.
- `refresh(program)` reports clean state after convergence and drift after
  out-of-band state mutation.
- `destroy(program)` removes the fixture resources and returns destroyed
  outputs.
- The package passes a local `@hobo/conformance/iac-backend` proof over
  preview, apply, refresh, and destroy.
- OpenTofu version drift, unsupported HCL mappings, state-lock contention,
  binary plan skew, and partial apply fail closed with typed errors.

## Scope boundaries

This is a contract POC, not the production OpenTofu adapter. It does not shell
out to a real binary or implement compensation. The POC keeps the real seams
visible: the IacProgram emission contract and per-resource state model are
consumed, provider adapters only emit programs, and Pulumi/Crossplane/CDKTF
remain separate slices.

## Check

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-opentofu-backend-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Iac Opentofu Backend Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
