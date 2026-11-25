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

### Translations

`renderPulumiYamlProgram` turns the resource classes `@hobo/provider-cloudflare`
realizes into Pulumi Cloudflare v6 resources, and refuses any other class with
`pulumi-unsupported-resource-type`:

| HoBo class | Pulumi type | Inputs |
|---|---|---|
| `cloudflare:workers-script` | `cloudflare:WorkersScript` | `name`, `content` |
| `cloudflare:kv-namespace` | `cloudflare:WorkersKvNamespace` | `title` |
| `cloudflare:r2-bucket` | `cloudflare:R2Bucket` | `name` |
| `cloudflare:queue` | `cloudflare:Queue` | `queueName` |
| `cloudflare:cron-trigger` | `cloudflare:WorkersCronTrigger` | `scriptName` (its one dependency, which the Cloudflare realizer must type as `cloudflare:workers-script`), `schedules: [{ cron }]` from the Cloudflare option `cron` |

A cron trigger is refused rather than created with a guessed cadence or
target when it has no `cron` option, or when its one dependency is not a typed
Workers script. The cadence comes from the Bindle's `cadence` trait: the
planner puts it in the node's realization parameters, and the Cloudflare
realizer turns it into the `cron` option. The realizer (`realizeResourcePlans`
in `@hobo/provider-cloudflare`) records each binding's `resourceType` from its
sibling plans; an untyped binding, or one on a queue, is not a Worker. A
schedule on a queue, like the CI relay's repair schedule, is a Vercel schedule
(`vercel.json`), never a Cron Trigger.

### State secrets

Both engines keep their state under a local `file://` backend. Pulumi encrypts
the secrets in it with `PULUMI_CONFIG_PASSPHRASE`; an empty passphrase leaves
them readable by any process that can read the state directory. For a retained
workspace, pass a recoverable non-empty `statePassphrase` from the caller's
secret store; `PULUMI_CONFIG_PASSPHRASE` in the caller's environment is not
read, and the engine sets it only in the Pulumi child's environment for that
call. Reuse the same key when reopening the state. Without one,
operations refuse before creating or changing state. A caller that guarantees a
workspace is disposable may explicitly set `ephemeralState: true`; its key is
random, kept in memory, and lost when the process ends.

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
