# @hobo/iac-terraform

The HCL-lane `IacProvider` (HOBO-717): **one adapter, two interchangeable
binaries**. OpenTofu (`tofu`) is the default per
[control-plane.md §IaC backends](../../../docs/design/control-plane.md);
Terraform (`terraform`) is selectable per engine — they share the
plan/apply/state protocol, so nothing above the engine seam changes.

## Model

Each resource in an `IacProgram` gets its own HCL **workspace**
(`deploymentId/resourceName`) with its own local state, so blast radius stays
isolated — the same per-resource model as `@hobo/iac-pulumi`'s stacks. The
adapter guards plan/apply divergence, reports drift via `refresh`, holds
per-workspace locks, and resolves `${resources.X.outputs.Y}` references into
bindings.

## Engines

- **In-memory** (`createInMemoryHclEngine`) — offline, deterministic; the
  default so the package builds and tests without any binary.
- **CLI** (`createTerraformCliEngine`) — the REAL lane: renders deterministic
  per-resource `*.tf.json` programs and drives `init`/`plan -out` +
  `show -json`/`apply`/`apply -refresh-only`/`destroy`.
  `hobo:trivial/greeting` maps to the **builtin `terraform_data`** (no provider
  download — a genuinely offline-capable real lane when a binary is present);
  cloudflare tokens pin `cloudflare/cloudflare ~> 4.0`. A missing binary or an
  unmapped resource class fails closed with a typed
  `TerraformEngineUnavailableError`.

`parsePlanChanges` (pure, fixture-tested) parses `show -json` plan documents
into the typed change summary and fails dirty on malformed input.

### OpenTofu

There is deliberately **no separate `iac-opentofu` package**: OpenTofu and
Terraform share the plan/apply/state protocol, so the CLI engine treats them
as interchangeable binaries behind one flag —
`createTerraformCliEngine({ binary: "tofu" })` (the **default**) or
`{ binary: "terraform" }`. Version pins live beside the engine
(`PINNED_TOFU_VERSION` / `PINNED_TERRAFORM_VERSION`). This is the resolved
form of the `iac-opentofu` roadmap entry
(docs/plans/0017 F33).

## Exports

- `createTerraformAdapter` — the `IacProvider` adapter.
- `runIacBackendConformance` — the `@hobo/conformance/iac-backend` suite
  (`preview-diff / apply-outputs / binding-outputs / refresh-clean / destroy-clean`),
  identical assertion names to the Pulumi/Crossplane lanes.
- `validateIacProgram`, `createTrivialIacProgram`, `createWorkspaceKey`,
  `outputsToBindings`, `createInMemoryHclEngine`, `createInMemoryStateBackend`,
  `createTerraformCliEngine`, `renderTerraformJsonProgram`, `parsePlanChanges`,
  `IAC_TERRAFORM_PORT`.

## Verification

```sh
pnpm --filter @hobo/iac-terraform build
pnpm --filter @hobo/iac-terraform test
pnpm --filter @hobo/iac-terraform test:contract:consumer
```

Binary-gated tests (`it.runIf`) additionally run the real conformance smoke
over `terraform_data` when `tofu` or `terraform` is on PATH.
