# @hobo/iac-terraform — Architecture Evidence

Production HCL-lane IaC backend (HOBO-717). Promotes the
`src/draft/technical-proofs/iac-opentofu-backend-contract` shape into
`packages/iac/iac-terraform/`: ONE adapter driving the OpenTofu (`tofu`,
default per control-plane.md §IaC backends) or Terraform (`terraform`) binary
— they share the plan/apply/state protocol — over per-resource workspaces.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the IaC program
  spec, preview diff, drift report, apply outputs, state-backend config, and
  the plan-change summary parsed from `show -json`.
- CUE constraints in `data-models/iac_terraform.cue` bound every protobuf
  message and enum in that schema.
- PACT consumer evidence for the IaC backend boundary lives under
  [`contracts/`](./contracts) and is exercised by `contracts/consumer`.

## Parse, don't validate

`validateIacProgram` is the single parse, don't validate boundary: an
untrusted `IacProgram` DTO becomes a frozen, derived parsed domain program
(checked apiVersion/kind/provider ∈ {terraform, opentofu}, unique resources,
resolvable `${resources.X.outputs.Y}` references) before any preview or apply
runs. Callers receive derived parsed domain types instead of re-checking raw
fields; `parsePlanChanges` parses untrusted `show -json` documents into the
typed change summary and fails DIRTY (never silently clean) on malformed
input. Adapters depend on the `IacProvider` contract in `src/port.ts`, built
through `@hobo/core`.

## Per-resource workspace model

`createWorkspaceKey` maps each resource to `deploymentId/resourceName`, one
HCL workspace (own local state) per resource, so a failed apply cannot corrupt
unrelated resources — the same blast-radius isolation the Pulumi adapter's
per-resource stacks give (control-plane.md §IaC state model).

## Event architecture

The adapter is the Executor-facing effector in the provisioning command/event
loop: a Deploy command becomes `deployment.Planned`, the ResourceActor (the
single-writer actor over its event-store stream) dispatches the IacProgram
here, and outcomes land as `resource.Provisioned` / `resource.Failed` facts.
`snapshotState()` is the estate snapshot the drift/import materialized-view
projections read; the registry/deployment read stores rebuild from the event
log, never from adapter-held state. State-lock contention surfaces as a typed
`TerraformStateError` so the actor's lease (not the HCL lock) stays the
single-writer authority.

## Engines

- `createInMemoryHclEngine` — offline, deterministic default (mocked lane).
- `createTerraformCliEngine` — the REAL binary lane (`tofu` default,
  `terraform` supported); renders deterministic per-resource `*.tf.json`
  programs (`hobo:trivial/greeting` → builtin `terraform_data`, offline-capable;
  cloudflare tokens pinned to `cloudflare/cloudflare ~> 4.0`); fails closed
  with typed `TerraformEngineUnavailableError` codes when the binary is
  missing or a resource class has no real translation.

Both pass the identical `runIacBackendConformance` suite
(`preview-diff / apply-outputs / binding-outputs / refresh-clean / destroy-clean`)
— the same assertion names as the Pulumi and Crossplane lanes.
