# HOBO-15 WASI Interface Pins Proof

This executable proof pins the M0 contract for reused WASI interfaces from
[Plan 20](../../wasm-runtime-wit.md#plan-20) and
[ADR-0031](../../adr/01-architecture-core.md#adr-0031).

**Promoted to production:** vendored `wasi:*` pins and round-trip fixtures live in [`packages/wit`](../../../../packages/wit/README.md) (`@hobo/wit`, HOBO-583).

## Contract Surface

- HoBo records exact `wasi:*` interface pins for HTTP, keyvalue, blobstore, messaging, SQL,
  config, logging, filesystem, sockets, clocks, random, and CLI host primitives.
- Each pin records `interface@version@stability`, the vendored source path, and a SHA-256 digest.
- A manifest fragment carries the pinned imports and the component-host version boundary.
- Keyvalue, blobstore, messaging, config, and logging have round-trip fixtures that simulate
  encode -> linked provider export -> decode identity.

## Proof Boundaries

This proof is structural. It does not implement provider backends, a real component host, or the
full `@hobo/conformance/component-host` suite. Those later slices consume these pins and extend the
same checks across real hosts/providers.

## Executable Checks

Run:

```powershell
node --test src\draft\technical-proofs\wasi-interface-pins\test\wasi-pins.test.ts
```

The checks prove:

- the vendored WIT files match their recorded SHA-256 digests,
- a digest mismatch fails closed before an interface can be used,
- the required round-trip fixtures preserve shape identity,
- the manifest fragment records version and stability for every pin,
- an unlinked interface such as preview `wasi:websocket` cannot pass this fixture.
