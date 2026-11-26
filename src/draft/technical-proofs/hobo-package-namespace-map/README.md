# HoBo Package Namespace Map POC

This POC captures the HOBO-58 namespace decision as executable data. It mirrors
`docs/design/package-namespaces.md` and gives future boundary lint a concrete
shape to adopt when the monorepo package graph exists.

## Run

```bash
npm test
```

or from the repo root:

```bash
npm --prefix src/draft/technical-proofs/hobo-package-namespace-map test
```

## Contract

- App authoring symbols resolve to `@hobo/bindles` or `@hobo/runtime`.
- Topology factories stay in `@hobo/camps`, `@hobo/yards`, and
  `@hobo/junctions`.
- Operator/self-host symbols resolve to npm `@hobo/sdk`.
- `@hobo/bindles` does not re-export topology, runtime control flow, or operator
  SDK symbols.
- `secret()` and `secretRef()` are both app authoring symbols, but the former is
  a managed secret resource and the latter is a config-value reference.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Package Namespace Map.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
