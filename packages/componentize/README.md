# @hobo/componentize

`@hobo/componentize` builds TypeScript services as WebAssembly Component Model
artifacts with `@bytecodealliance/componentize-js`, emits OCI descriptors, and
executes exported functions with the pinned Wasmtime runtime.

Production callers use `createRealComponentize()` and fail closed when the
pinned toolchain is unavailable. `runWasmtimeSmoke()` validates the component
layer and digest before invoking the requested export in Wasmtime.
Real-build metadata records the bundled source and WIT interface digests. The
component digest describes the emitted bytes; identical inputs do not guarantee
byte-identical output from the pinned componentizer.

`componentizeHelloBindle()` and `runContractSmoke()` provide the deterministic
contract fixture used by offline boundary and digest tests. Their output is not
accepted by the production component validator or Wasmtime runner.
