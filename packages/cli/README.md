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

## Project discovery

Project-scoped verbs walk up from the working directory (or `--cwd`) to the
first directory holding a project marker: `hobo.bindle.json`, `bindle.ts`/`.js`,
`src/bindle.{ts,mts,js,mjs}`, `dist/bindle.js`, `app.{ts,mts,js,mjs}`, or a
project `.hobo/` (`codegen`, `stub` and `build` also accept `tsconfig.json`).
With none, the verb fails with `HOBO_NO_BINDLE`.

A `.hobo/` counts only when it is a project's state (`session.json`,
`generated/`, `build/`, `sources/`, …). It does not count when it is the
user's own HoBo home — the one `HOBO_HOME` resolves to, or the default
`$HOME/.hobo` while `HOBO_HOME` points elsewhere — or when everything in it is
user-level state: dotfiles aside, only names in `HOBO_HOME_ENTRIES`
(`@hobo/core/hobo-home`: `durable/`, `runtime/`, `stations/`, `keys/`, `tools/`,
`sandboxes/`, `worktrees/`, `workspaces/`, `worlds/`, `yards/`, `oci/`,
`connections/`, `claims/`, `auth-md/`, `evidence/`, `trust-roots/`,
`identity-migrations/`, `last-resort-runner/`, `profile.json`, `yard.json`,
`installed-runtimes.json`, `hobo.broker.json`, `broker-runtime.json`).
`test/hobo-home-entries.test.ts` fails when a package or an example joins a
name under a HoBo home that the list lacks, or builds a HoBo home from HOME by
hand instead of through `resolveHoboHome`.

Every marker, not only `.hobo/`, counts only when it is the current uid's own,
because discovery decides which `app.ts` or `bindle.ts` `hobo` loads and runs:
a marker a stranger could plant or swap is code execution as the user. Like
git's `safe.directory`, and stricter, discovery checks each marker with
`lstat` (`src/shell/marker-trust.ts`) and trusts it only when:

- it is not a symlink (a symlink is never followed);
- the current uid owns it, and it is neither group- nor world-writable;
- the directory holding it (for `src/bindle.ts`, `src/` and the project
  directory) is owned by the current uid or by root and is not
  world-writable, so `/tmp/app.ts`, or a stranger's `bindle.ts` in a 1777
  scratch directory, never counts;
- for a `.hobo/`, each entry discovery reads in it (`session.json`,
  `generated/`, …) passes the same check as the marker. A `.hobo/` whose
  entries all fail marks nothing: a `session.json` someone else wrote proves
  nothing about whose project it is.

Anything that fails is skipped with one line on stderr naming the path, why,
its owner and its mode, for example
`hobo: ignoring /tmp/scratch/app.ts as a project marker: not owned by uid 1000 (owner uid 4242, mode 0644)`,
and the walk goes on to the next marker. A file that is group-writable only
because of a `umask` of `002` is skipped too; `chmod g-w` it. Where there is
no uid (Windows) nothing is checked. Before these rules, every directory under
`$HOME` resolved to `$HOME`, and a stray `/tmp/.hobo` or `/tmp/app.ts` made
`/tmp` the project of every temp dir.

`HOBO_CEILING_DIRECTORIES` bounds the walk the way `GIT_CEILING_DIRECTORIES`
bounds git's: a `:`-separated (`;` on Windows) list of absolute paths. A ceiling
stops only a walk that starts below it: the walk examines the starting
directory, then each parent, and stops before it would move into a listed
directory, so a ceiling and everything above it go unexamined. As in git, a
ceiling equal to the starting directory does not stop the walk above it; list
its parent for that. Empty and relative entries are ignored. The tests that
need a walk to find nothing set it to their temp root: the no-Bindle test in
`test/shell.test.ts` and the cases in `test/project-discovery*.test.ts`. The
other cli tests put a marker in their own temp project, so the walk stops
there.

| Variable | Default | Effect |
| --- | --- | --- |
| `HOBO_CEILING_DIRECTORIES` | unset (walk to `/`) | Directories project discovery never walks up into |
| `HOBO_HOME` | `$HOME/.hobo` | The user's HoBo home; never taken for a project |

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
Compiler/process acceptance runs one isolated test file at a time to fit bounded
runners; concurrent-writer and provider race checks still run inside their owning
tests.

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
