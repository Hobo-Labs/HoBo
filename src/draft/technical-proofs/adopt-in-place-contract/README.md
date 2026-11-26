# Adopt-in-Place Contract

HOBO-369 proves the control-plane contract for `hobo import`, adopted nodes, and
external resource bindings. HOBO-225 extends the proof to Terraform-style import
fixtures, unsupported-resource externalization, brownfield deploy planning, and
PortabilityReport/zero-secret debt surfacing without implementing real
Pulumi/CDKTF/OpenTofu import readers or provider realization.

## Scope

- `importIacState()` maps fixture IaC state into `adopted` graph nodes.
- `createTerraformStateFixture()` proves a Terraform-state importer input.
- `planImportRoundTrip()` proves imported state replays as a no-op plan.
- Unsupported IaC resource types become `external` graph nodes instead of being
  force-adopted.
- `planBrownfieldDeployment()` deploys managed resources while skipping adopted
  and external resources.
- `createPortabilityPlanFromGraph()` emits portability markers for external,
  adopted, and static-key brownfield debt.
- Adoption emits `resource.Adopted` with source provenance.
- Adopted resources are retained on destroy and reconcile only through
  drift-detect refreshes.
- `external` resources expose declared outputs for managed resource bindings.
- Binding, import collision, drift, and idempotency failures return typed errors
  or no-op outcomes.

## Guardrails

- Imported resources cannot overwrite existing managed nodes.
- Adopted resources are never planned as destroy, recreate, provision, or update
  actions.
- Destroy plans skip adopted and external resources.
- External output declarations must match the values used by managed bindings.
- Drift on adopted resources is recorded for manual remediation only.
- Partial or corrupt IaC state fails before graph mutation.
- Static-key brownfield dependencies appear as zero-secret audit exceptions.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\adopt-in-place-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Adopt In Place Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
