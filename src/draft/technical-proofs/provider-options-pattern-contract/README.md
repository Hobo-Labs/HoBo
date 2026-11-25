# Provider Options Pattern Contract

Independent POC for HOBO-52. It pins the `.with(provider.option(...))` authoring contract as manifest annotations:

- provider options are additive and typed by provider/resource pairing;
- non-resolved providers stay recorded but inert;
- `prefer` and `require` serialize as distinct requirement markers;
- repeated options for the same provider merge deterministically unless a value conflicts;
- every `.with()` annotation records a PortabilityReport-readable lock-in marker.
- `test-types/` keeps provider/resource pairing and provider option value types
  compile-time enforced, so invalid `.with()` combinations do not silently
  degrade to runtime-only guards.

Run:

```sh
npm test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Options Pattern Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
