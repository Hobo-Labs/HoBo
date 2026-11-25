# IaC Drift Refresh Fidelity Contract

HOBO-217 proves the `refresh() -> DriftReport` fidelity contract for provider-backed IaC stacks.
It is an offline POC over in-memory Pulumi/OpenTofu-shaped fixtures; it does not implement the
ResourceActor resync trigger, drift remediation policy, or the adopt-in-place importer.

## Scope

- `evaluateRefreshReport()` compares desired per-resource stack state with provider-observed reality.
- Managed resources report exact out-of-band update, create, and delete drift.
- Provider-normalized fields are ignored only when declared as normalized paths on the desired resource.
- `reconcileDriftReport()` proves level-triggered convergence for managed drift and a second no-op pass.
- Adopted resources are detect-only: drift is recorded but never destroyed or recreated.
- Co-provisioned child drift is attributed to the child resource, not the parent stack.
- `runRefreshFidelityConformance()` requires the camp-tagged refresh-fidelity check and rejects flaky
  refresh implementations that intermittently miss drift.

## Proven Behaviors

- Out-of-band API image update, missing worker resource, and extra debug resource are reported exactly.
- Provider-rewritten `observed.revision` and `spec.serverDefaultedSku` do not cause perpetual false drift.
- First reconcile converges managed drift; second reconcile is a no-op.
- Adopted `legacy-db` drift is recorded in detect-only mode and the observed endpoint remains untouched.
- Co-provisioned `api-log-group` retention drift is reported on the child resource only.
- A flaky provider returning a clean report between drift reports fails conformance with
  `refresh-intermittent-miss`.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-drift-refresh-fidelity-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Iac Drift Refresh Fidelity Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
