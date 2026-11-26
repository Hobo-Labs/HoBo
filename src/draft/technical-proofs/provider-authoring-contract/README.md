# Provider Authoring Contract POC

This draft covers HOBO-87: the M0 provider-package authoring contract for a
human-authored or generated provider package.

It pins this public surface:

- `defineProvider(...)` creates a provider package with `id`, declared capability
  ports, scoped `.with` option builders, `client(port, outputs)`, and
  `capabilityManifest()`.
- `createOptionBuilder(...)` produces provider-scoped option blocks. A builder
  must belong to the provider and target a declared port.
- `resolveProviderOptions(...)` models planning-time merge behavior: only the
  resolved provider's option blocks survive; unrelated provider blocks are
  dropped with evidence.
- `mergeResolvedProviderOptions(...)` is the type-level version used by the
  type tests to reject cross-provider option blocks before runtime.
- `auditProviderCatalog(...)` reports same-named unqualified option builders
  across providers so call sites use provider-scoped access.

The source module exports the same provider, capability, client, and option
block type surface that the declaration file advertises. The proof intentionally
keeps runtime tests and type tests together so the provider authoring API fails
closed both for invalid dynamic packages and for incompatible compile-time
callers.

Out of scope by issue contract: `realize()` emission, equivalence mappings,
default Resource Definitions, and conformance harness internals.

Run:

```powershell
pnpm.cmd --prefix src\draft\technical-proofs\provider-authoring-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Authoring Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
