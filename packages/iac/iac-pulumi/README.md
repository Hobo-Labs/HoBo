# @hobo/iac-pulumi

Production Infrastructure-as-Code backend for HoBo built on the Pulumi Automation
API. S2-05 promotes the near-production draft proof
(`src/draft/technical-proofs/s2-06-iac-pulumi-automation-adapter/`) into
`packages/iac/iac-pulumi/`.

The adapter satisfies the `IacProvider` port with a per-resource stack model:
each resource in an `IacProgram` gets its own Pulumi stack
(`deploymentId/resourceName`) so blast radius stays isolated. It guards against
preview/apply divergence, reports drift, holds per-stack locks, and resolves
`${resources.X.outputs.Y}` references into bindings.

## Engines

The default backend is a deterministic in-memory Automation engine so the package
builds and tests without the Pulumi CLI. `createPulumiAutomationAdapter({ engine })`
takes any engine speaking the same preview/apply/refresh/destroy shape — three ship
today, all pinned to `PINNED_PULUMI_AUTOMATION_VERSION` (`3.130.0`):

- **In-memory** (`createInMemoryAutomationEngine`) — offline, deterministic; the
  default for the mocked lane.
- **Automation API** (`createPulumiAutomationApiEngine`, HOBO-715) — the REAL
  design-pinned embedding: `@pulumi/pulumi/automation` `LocalWorkspace` drives the
  same rendered per-resource YAML programs against a `file://` state backend, no
  hand-rolled shell-out. Fails closed with typed errors when the `@pulumi/pulumi`
  module (`pulumi-automation-module-missing`) or the embedded engine binary
  (`pulumi-cli-missing`) is unavailable. The real path preflights the binary
  before loading the Automation module. `snapshot()` enumerates the estate by
  parsing file-backend checkpoints directly (sync, engine-free).
- **CLI** (`createPulumiCliAutomationEngine`) — drives the pinned `pulumi` binary
  directly; kept for the `HOBO_PULUMI_BIN` test seam and as an explicit opt-in.
  Invalid preview JSON fails dirty so apply cannot mistake it for a clean plan.

The composed runtime's live lane (`HOBO_PULUMI_LIVE=1`, see `@hobo/hobo`
`compose.ts`) defaults to the Automation API engine; `HOBO_PULUMI_LIVE_ENGINE=cli`
(or setting `HOBO_PULUMI_BIN`) selects the CLI engine instead.

## Exports

- `createPulumiAutomationAdapter` — the `IacProvider` adapter.
- `runIacBackendConformance` — the `@hobo/conformance/iac-backend` suite
  (`preview-diff / apply-outputs / binding-outputs / refresh-clean / destroy-clean`).
- `validateIacProgram`, `createTrivialIacProgram`, `createPerResourceStackKey`,
  `outputsToBindings`, `createInMemoryAutomationEngine`, `createInMemoryStateBackend`,
  `createStateBackendConfig`, `IAC_PULUMI_PORT`.

## Verification

```sh
pnpm --filter @hobo/iac-pulumi build
pnpm --filter @hobo/iac-pulumi test
pnpm --filter @hobo/iac-pulumi test:contract:consumer
```
