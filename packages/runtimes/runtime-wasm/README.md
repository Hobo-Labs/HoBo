# `@hobo/runtime-wasm`

Camp **component host** backend for `componentHost=wasm` (alias: `isolated-wasm`).

Private bindle components are componentized to the HoBo HTTP world and run in
real **Wasmtime OS-process sandboxes**. The world exports the standard WASI HTTP
incoming handler and imports the outgoing handler without requiring standard
input. The vendored standard `wasi:http/proxy` world remains available with its
original imports. Public web stays process-local (wired by `@hobo/hobo`).

The WASI HTTP interface semantics are defined by the
[upstream 0.2.3 specification](https://github.com/WebAssembly/wasi-http/tree/v0.2.3/wit).

```ts
import { createWasmRuntimeHost, ensureWasmRuntime } from "@hobo/runtime-wasm";

const host = createWasmRuntimeHost();
await host.ensure({ hoboHome: process.env.HOBO_HOME! });
const privateServe = await host.servePrivate({
  hoboHome,
  projectDir,
  privateComponents: [{ resourceName: "api", projectDir }],
});
```

Wired by the composition root (`hobo yard init --host wasm`). Generated guests
apply `x-hobo-bindle-env` and per-key mesh headers to `process.env` before the
application fetch handler runs.

## Toolchain resolution

`ensureWasmtimeBinary` resolves in order: explicit `binPath`, `HOBO_WASMTIME_BIN`,
`$HOBO_HOME/tools/wasmtime`, `PATH`, then downloads the pinned release into
`$HOBO_HOME/tools` (atomic temp-file + rename, so concurrent ensures never see a
partial binary). Tests share one warm cache: `test/wasmtime-global-setup.ts`
(vitest `globalSetup` in the root `vitest.config.ts`) pre-installs wasmtime once
into the default HOBO_HOME and exports `HOBO_WASMTIME_BIN`, so tests using
throwaway HOBO_HOME dirs don't re-download per test under parallel sweeps.
Componentization uses `$HOBO_HOME/cache` for its compiler cache and passes only
that cache location into the compiler's initialization environment.

## Architecture rules

Parse, don't validate: WIT/component inputs cross one parser boundary at the
Wasm host and become derived types (parsed component refs, capability grants);
the host never passes raw descriptor DTOs into the runtime core.

## Guest environment regression gate

The generated WASI entry parses the `x-hobo-bindle-env` JSON object with
self-contained guards; it cannot reference TypeScript host-only helper names.
`packages/hobo/test/wasm-guest-generic.test.ts` componentizes and executes a guest
in Wasmtime and checks tenant environment injection. This is an execution gate
beyond the runtime's TypeScript build: template contents are compiled separately
by esbuild and componentize-js.
