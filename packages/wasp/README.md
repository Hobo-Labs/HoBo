# @hobo/wasp

The Wasp webApp primitive for HoBo Bindles: `b.web(waspApp("path/to/app"))`.

This package **ingests**, it does not deploy. It reads a Wasp / Open SaaS
application directory, stamps a marker Bindle detects structurally, and reports
which Bindle resources the app's declared environment implies. It never runs
`wasp`, never reads a `.env`, and never resolves a value.

## What it actually does

| Surface | What it produces |
|---|---|
| `waspApp(root)` | A `DeclaredComponent` stamped with `{ framework: "wasp", root }` on `Symbol.for("hobo.webapp.meta")` (and the Wasp-specific symbol). Bindle's `webAppAnnotationFromBinding` picks it up structurally. |
| `waspAnnotation` / `waspRootFromAnnotations` | The `{ provider: "hobo", option: "webapp", config: { framework, root } }` annotation, and the way back out of a definition. |
| `discoverWaspEnv(repoRoot, root)` | The declared **keys** of `.env.server.example` and `.env.client.example`, the four Open SaaS general deploy vars, and a Bindle dependency suggestion per resource kind. |

Two things are deliberately *not* in the annotation: a source URL and a
template id. A manifest that records where an app was downloaded from pins the
Bindle to that origin, and `test/wasp-app.test.ts` asserts neither appears.

### Verified against official documentation

| Source | Checked | What it confirmed |
|---|---|---|
| <https://docs.opensaas.sh/guides/deploying/> | 2026-08-08 | The four general deploy vars: `DATABASE_URL`, `JWT_SECRET`, `WASP_WEB_CLIENT_URL`, `WASP_SERVER_URL` |
| <https://wasp.sh/docs/project/env-vars> | 2026-08-08 | Client env vars must be prefixed `REACT_APP_` to reach the browser bundle |

## Parse, don't validate

`src/parse.ts` is the only place an application tree crosses into this package,
and what comes out are **derived domain types**:

- `parseWaspAppRoot` resolves the repo-relative directory once and returns a
  `WaspAppRoot` holding both forms. The traversal-and-escape check happens
  there, comparing against `repoRoot + separator` so a sibling directory whose
  name merely starts with the repo's cannot pass. After it, "inside the repo" is
  a property of the value. `parseWaspRelativeRoot` is the shape-only half, used
  by `waspApp()` itself, because the marker travels into a manifest long before
  anyone resolves it.
- `parseWaspEnvExample` reduces a declaration file to `WaspEnvKey`s — and to
  nothing else. **Values are never read**: the parser takes the text left of the
  first `=` and discards the remainder unread, so there is no code path on which
  a value from an app tree reaches a Bindle manifest. `.env.example` files are
  documentation, but they sit next to the real `.env` and are routinely copied
  from one. The returned `WaspEnvExampleFile` has no field a value could occupy.
- Client scope is enforced, not assumed: a key in `.env.client.example` without
  the `REACT_APP_` prefix is dropped, because Wasp would never compile it into
  the bundle and calling it a client var would claim a credential is public.
- `parseWaspWebAppMeta` / `parseWaspWebAppAnnotation` are how a marker stamped
  by arbitrary user code becomes one this package vouches for; `waspMetaOf` and
  `waspRootFromAnnotations` are thin wrappers over them.
- Rejections are one type, `WaspInputRejectedError`, carrying the code
  `HOBO_WASP_INPUT_REJECTED` and the offending field.

The filesystem itself is a port: `WaspSourceReader` has one method, and
`nodeWaspSourceReader` is the default. That is what lets the contract test drive
the real `discoverWaspEnv` with no app on disk.

`data-models/wasp_app.proto` is the design-time wire view of these shapes and
`data-models/wasp_app.cue` carries the invariants the parsers enforce
(upper-snake env keys, `REACT_APP_` on every client key, a relative path with no
`..` segment, a pinned `hobo`/`webapp`/`wasp` annotation triple, and a
`container` suggestion reachable only from `DATABASE_URL`). The parsed types
above are the executable view of that pair. No buf codegen is wired for this
package, so the TypeScript declarations sharing a proto message name are marked
`domain-view:` where they are declared.

## Event architecture

This package holds no state: no reducer, no stream, no store. It contributes
declarations to a Bindle, and the durable machinery is the run-to-collect
collection engine in `@hobo/bindles` (`src/collect/`).

1. The **command** is a collection run — `collect(bindle)` — issued when an
   author's Bindle is compiled. `waspApp()`, `waspAnnotation()`, and
   `discoverWaspEnv()` are what that run consults here: the first two while the
   components execute in resource-collection mode, the third when an author asks
   what the app's environment implies.
2. The run appends exactly two **events**, both pinned in
   `packages/bindles/data-models/collection_events.proto`:
   `bindle.ResourcesCollected` (seq 1) carrying the resources and bind edges
   observed, then `bindle.ManifestProduced` (seq 2) carrying the canonical
   manifest hash. This package's contribution rides inside the first: the
   `webapp` annotation on the web resource, and nothing else.
3. The collection engine is the **actor**: it runs the components, folds the
   observed resources into the manifest IR, and is the only thing that appends.
   Event ids are content-addressed, so two runs of the same Bindle emit
   byte-identical events — the determinism gate depends on this package being a
   pure function of the app tree, which is another reason no value is read.
4. Those facts land in the durable **event store** — the SQLite-backed journal
   behind the ports in `@hobo/storage-sqlite` (ADR-0135), one partition, one
   writer, appends fenced by stream head.
5. `canonicalManifestHash(manifest)` over the folded `ManifestV1` is the
   **snapshot**: a content-addressed summary the next run compares against
   instead of re-deriving. The manifest IR itself is the **materialized view**
   that downstream planes project from, and the manifest/IR registry is the
   **read store** the deploy plane and `hobo plan` read — `parseManifest` is its
   entry parser.

Because the annotation carries only `framework` and `root`, the read model can
show which app a Bindle points at without recording where the app came from or
what its environment is set to.

## Usage

```ts
import { bindle } from "@hobo/bindles";
import { discoverWaspEnv, waspApp } from "@hobo/wasp";

const definition = bindle((b) => {
  const db = b.container({ image: "postgres:16-alpine" });
  const web = b.web(waspApp("examples/wasp-opensaas/app")).dependsOn(db);
  return { db, web };
});

const discovered = await discoverWaspEnv(process.cwd(), "examples/wasp-opensaas/app");
discovered.suggestedDeps;
// [{ kind: "container", via: "b.container({ image }) …", keys: ["DATABASE_URL"] }, …]
```

## Tests

Fully offline. `test/wasp-app.test.ts` reads the real
`examples/wasp-opensaas/app` tree; `test/source-tree.contract.test.ts` replays
the pact through a faked `WaspSourceReader`.

```sh
pnpm --filter @hobo/wasp test
```

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the consumer-driven
contract in `contracts/wasp-app-source-tree.pact.json`, and the protobuf + CUE
boundary shapes in `data-models/`.
