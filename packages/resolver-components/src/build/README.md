# `src/build/` — the componentize build recipe

- `componentizeResolver({ componentId, version, source })` — deterministic
  contract bytes: wasm header plus a `hobo.resolver.contract` custom section
  (`hobo.resolver-components.contract/v1`: world, id, version, source digest).
  Same honest-scope floor as `@hobo/componentize`.
- `componentizeResolverReal({ sourceRoot, sourceDateEpoch, witSource })` —
  the pinned componentize-js lane through `@hobo/componentize`, against the
  `hobo:resolver/resolver-component` world; fails closed with
  `ComponentizeToolchainError` when the toolchain is absent (never falls back
  silently).
- `buildResolverComponent(manifestJson, wasm)` — stamps `wasm_digest`, parses
  the manifest, and returns the registry bundle manifest and the digest the
  publisher signs as `codeVersion.digest`.

## Runbook

- `ComponentizeToolchainError`: install the pinned
  `@bytecodealliance/componentize-js` or use the synthetic lane explicitly.
- The bytes changed between builds: the source text differs (the contract
  section binds its sha256); rebuild from the tagged source.
