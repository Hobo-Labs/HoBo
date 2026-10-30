# @hobo/cli

HoBo command-line **shell and command factories** — parser, verb registry,
renderer, dispatch seam, offline `hobo new` scaffolds, and un-injected stub
handlers for the local developer loop.

The **product** `hobo` / `hobo-mcp` binaries ship from **`@hobo/hobo`**
(`packages/hobo/`), which injects default runtimes so lifecycle verbs run end to
end. This package is the library surface (`dispatchCommand`, `CANONICAL_VERBS`,
command factories). Prefer `@hobo/hobo` for end-user CLI use.

**Dual-bin / install story:** the composed product bin is `@hobo/hobo`. Treat
this package as the shell/factories dependency, not as a second product CLI.
Ship and publish policy: [ADR-0140](../../docs/design/adr/07-portability-extensibility.md#adr-0140),
[`docs/design/launch-ship-targets.md`](../../docs/design/launch-ship-targets.md),
[`docs/plans/0012-ship-remediation-plan.md`](../../docs/plans/0012-ship-remediation-plan.md).

Promotes:

- `src/draft/technical-proofs/hobo-cli-shell-contract/` (CLI shell, parser, registry, renderer, dispatch seam)
- `src/draft/technical-proofs/hobo-new-scaffold-contract/` (`hobo new` offline scaffolds)

`hobo new -t todo|api|agent|fullstack` is a compatibility adapter. File bodies
come from `@hobo/patterns` `starter.cli.*` catalog trees (ADR-0153). Aliases
stay the public contract; do not fork starter text back into this package.
- `src/draft/technical-proofs/hobo-build-cli-contract/` (`hobo build` orchestration, HOBO-613 / S1-23)
- `src/draft/epic-proofs/cli-mcp-developer-experience/` (CLI↔MCP parity boundary)

The product `hobo build` produces executable Node bundles, real WASM components,
or complete OCI image archives. It checks codegen freshness first and atomically
replaces artifacts and their manifest after a successful build. Product WASM
builds require the real componentizer toolchain. Product container builds use a
service Dockerfile through Docker Buildx or self-hosted BuildKit
(`HOBO_CONTAINER_BUILDER=buildctl`). Library fixture callers retain the
componentizer seam and contract artifact lane for digest-parity tests.

## Surface

Canonical verbs: **43**, defined in `src/shell/verbs.ts` — including lifecycle
(`up`, `down`, `dev`), identity (`login`, `connection`, `identity`, `access`,
`claim`), delivery (`feature`, `deploy`, `ci`, `incident`), control plane (`broker`,
`yard`, `station`), observability (`replay`, `logs`, `inspect`), governance
(`attest`, `erase`, `runbook`), and the authoring/diagnostics set
(`plan`, `verify`, `can-deploy`, `doctor`, `codegen`, `build`, `collect`, `stub`,
`drift`, `add`, `registry`, `import`, `generate`, `sandbox`, `test`, `derivative`,
`trails`, `new`), plus `recipes`, `offer`, `messaging`, and `serve`.

Global flags: `--json`, `--camp <camp>`, `--cwd <path>`, `--verbose`, `-q`, `--help`.

`hobo ci` shows setup help. `hobo ci enable` (alias `connect`) connects a GitHub
repository; `list`/`ls`, `inspect`, `logs`, `grep`, and `rerun` operate on its
GitHub Actions runs using the authenticated GitHub CLI (`gh`). `status` inspects
the relay connection. A sole Git remote is selected automatically; pass
`--remote <name>` to select among several. After connection, use `runs-on: hobo`
in an Actions workflow and push a commit.

CI works in ordinary Git repositories without a Bindle. The shell handles output,
cwd and help flags;
the composed CI handler strictly parses its own setup options. TypeScript and
the shell dispatch contract tests pin this boundary; the existing envelope
protobuf/CUE contracts continue to describe the command output.

This package exposes `dispatchCommand` for MCP parity; the composed MCP binary
ships from `@hobo/hobo` (`hobo-mcp`).

## Usage

Library consumers import from `@hobo/cli`. For a local shell binary without the
composition root, run the built entry with Node (factories may return stubs
until runtimes are injected):

```bash
pnpm exec turbo run build --filter @hobo/cli
node packages/cli/dist/bin/hobo.js --help
node packages/cli/dist/bin/hobo.js new my-app -t api
```

Product composition (recommended for end-to-end local lane):

```bash
pnpm hobo --help          # root script: builds @hobo/hobo on first use
# or: node packages/hobo/dist/bin/hobo.js --help
```

**Pre-release:** `@hobo/*` is **not published to npm** as a stable external
install story yet. Prefer the monorepo workspace until publish hygiene lands.
The composed product provides persistent self-hosted local deployments and
explicitly selected live provider paths; see [`packages/hobo/README.md`](../hobo/README.md).

## Contracts

- `contracts/cli-command-path.pact.json` — shell ↔ command registry boundary
- `contracts/hobo-new-scaffold.pact.json` — scaffold boundary
- `contracts/cli-componentize-boundary.pact.json` — build ↔ componentize boundary

Data models live in `data-models/` (protobuf + CUE), including `build_manifest.*` for `hobo build` records and `build.*` event families.

## Executable application generation

`hobo codegen` selects the app's source of truth. Explicit
`.hobo/sources/zod/resources.json` metadata uses the recursive schema engine;
ordinary TypeScript applications use their `tsconfig.json` and compiler-resolved
module graph. Canonical `hobo new` projects combine catalog seed regeneration
with the compiler-backed app imprint. Customized starter metadata follows the
actual TypeScript app rather than requiring a fixture-shaped JSON migration.
`hobo stub` and the build freshness gate select the same engine.

### TypeScript app imprints and native builds

Compiler-backed imprints preserve imported and nested types, generics,
overloads, class constructors/methods, namespaces and reexports through
`typeof import` bindings. Runtime modules are bundled with the original
TypeScript configuration, including `paths`/`baseUrl` and workspace-local
imports. Generation checks source diagnostics and bundles code without
executing application modules.

The imprint manifest hashes raw bytes for compiler and bundler inputs, including
JSON, binary assets, authored declarations, package metadata and extended
TypeScript configuration. Packaged HTTP deployment checks every remaining input,
including workspace sources, before loading the build. Removing source files
for distribution is supported; changing an available input requires rebuilding.
External input verification stays within the workspace declared by authored
package or pnpm metadata and rejects paths or symlinks escaping that boundary.

Entrypoints come from explicit engine options, package entry/export metadata,
conventional app/index files, or compiler dependency graph roots (including
cycles). Dependencies stay behind their authored exports and lazy imports;
importing the generated client does not eagerly initialize dynamic-only modules.

Generated `app.ts`, `bindings.ts`, trainable registrations and runtime assets
live under `src/_generated/app-imprint`; their manifest lives under
`.hobo/generated/app-imprint`. These narrow ownership boundaries preserve
neighboring generated models. Ambient trainables compose the existing grounding
registrations; `trainableMappings` links erased source declarations to actual
async calls in `app.trainables`. An exported local runtime declaration with no
implementation or executable registration fails generation rather than
producing a missing runtime export.

```bash
hobo codegen
hobo codegen --check
hobo stub --check
hobo build
```

For an app imprint without explicit service declarations, the auto build target
packages a real Node app at `.hobo/build/node-app/app.mjs`, together with its
runtime chunks and assets. Its manifest records hashes for every packaged
file. Standard Node can import `createAppClient()` / `getAppModule(path)` and
call the original application exports; no TypeScript loader or original source
tree is required. Explicit service declarations retain their component/container
build path. An explicit wasm/container request never silently returns Node
output. Build refuses stale codegen and preserves previous output on that
refusal. `packageTypeScriptAppArtifacts` also packages runtime assets beside a
separately compiled imprint client.

The product loader adapts a declared app's exported `api.run` or fetch handler
to the existing Bindle HTTP port. When source is unavailable, it can load the
packaged app after verifying the manifest's artifact hashes and any remaining
source hashes. `hobo up` serves that application persistently; `hobo down`
closes it.

### Nested schema APIs

The metadata engine reads the configured WIT/resource/scope/Bindle sources
(`src/codegen/types.ts`). Resource schemas support nested objects and arrays,
optional and nullable values, literal/enum values, tuples, records, unions,
intersections, exclusive variants, and references including recursive resource
and named definition graphs. Parsing produces the recursive generated
`CodegenFieldSchema` Protobuf record. Sparse arrays and tuples are rejected before
durable writes, so JSON serialization cannot turn missing elements into invalid
stored values. Unknown schema kinds fail with a source
error instead of becoming an untyped field. WIT marker checks in this metadata
path identify its package/world; the componentizer owns actual WIT/component
compilation.

The generated `api-tree.ts`, `hooks.ts`, `steps.ts`, `workflows.ts` and
`resource-runtime.ts` are implementations. Bindings and provider-option types
represent the same parsed model. The generated runtime accepts the application's
existing core EventStore, writes version-checked resource facts, rebuilds
projections, maintains snapshots, and delivers real subscriptions. Its workflow
adapter uses the existing runtime workflow engine and resumes committed steps
after reopening the durable store.

```ts
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import {
  api, createGeneratedRuntime, configureGeneratedRuntime,
} from "./src/_generated/api-tree.js";

const store = createRuntimeLocalEventStore({ dataDir: ".hobo/data" });
const runtime = createGeneratedRuntime({ store, tenant: "local", project: "shop" });
const unconfigure = configureGeneratedRuntime(runtime);
// Use api.resources.<declared-name>.query/get/put/remove/subscribe.
// The host owns its EventStore and authenticated actor/tenant context.
unconfigure();
runtime.close();
store.close();
```

Generated apps using this runtime install `@hobo/core`, the configured runtime
package (default `@hobo/runtime`, including its `/replay` export), and the store
adapter they instantiate (for the example, `@hobo/runtime-local`). No hosted
broker or relay is needed. Query/subscription hooks call the configured API;
`registerStep` installs executable implementations with schema-checked inputs
and outputs; `registerWorkflow` accepts an implementation or an ordered step
pipeline. Missing implementations throw before producing a successful result.

### Verification and contracts

The CLI and HOBO Vitest configurations load the installed TypeScript compiler
through Node. Native compilation, packaged-app execution and existing test
deadlines remain enforced without transforming the compiler's internals in Vite.
Compiler/process acceptance runs one test file at a time to fit bounded runners;
concurrent-writer and provider race checks still run inside their owning tests.

The tests execute the product paths, not only emitted string comparisons:

- `typescript-project-codegen.test.ts`: imported/nested/generic types,
  classes, overloaded functions, native packaged aliases and assets, virtual
  seed repair, and real grounding artifact application.
- `typescript-cli-integration.test.ts`: a plain tsconfig project through
  codegen, check, stub and build freshness selection.
- `starter-end-to-end.test.ts`: all four starters through scaffold, codegen,
  build and actual handler execution in plain Node.
- `packages/hobo/test/starter-deployment-end-to-end.test.ts`: all four starters
  through actual product deployment, HTTP requests and teardown after source
  removal.
- `generated-runtime-execution.test.ts`: strict compilation of all generated
  code, nested CRUD, subscriptions, typed steps, durable workflow resume and
  tenant isolation against a real SQLite store.
- `nested-schema-execution.test.ts` / `codegen-schema-contract.test.ts`:
  executable recursive validation, positive/negative Protobuf/CUE fixtures,
  exclusive variants, literals and closed objects.
- `codegen-tree-safety.test.ts`: path/ownership/symlink refusal, transactional
  rollback, concurrent-writer exclusion, SIGKILL recovery and exact binary-byte
  preservation. The persistent `.hobo-codegen.lock` SQLite file uses an OS-released
  transaction lock; interrupted filesystem swaps are restored from the staged
  recovery journal before a later codegen, build or freshness check proceeds.

`data-models/project_codegen.proto` and CUE define schema, artifact and generated
resource event payloads. `build_manifest.proto` / CUE include actual Node app
artifacts. The event-family registry names generated mutations. CLI boundary
contracts, compiler tests and real execution tests protect these paths together.
