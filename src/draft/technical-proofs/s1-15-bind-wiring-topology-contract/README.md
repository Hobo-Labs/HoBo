# S1-15 Bind Wiring + Topology Contract

Integrated draft POC for [HOBO-605](https://linear.app/quickdeploy-ai/issue/HOBO-605/s1-15-bind-reference-wiring-topology-objects-bindlecampyard-local). Promotes and wires together:

- `bind` reference wiring (`links`, lazy `ConnectionStrings__*` tokens, `addContainer` fluent surface) from [HOBO-49](https://linear.app/quickdeploy-ai/issue/HOBO-49/define-the-bind-reference-aspire-style-wiring-surface-typed-bindings) / `bind-reference-wiring-contract`
- first-class topology objects (`bindle`, `camp`, `yard`) from [HOBO-62](https://linear.app/quickdeploy-ai/issue/HOBO-62/implement-the-first-class-topology-objects-bindlecampyardjunction-as) / `topology-objects-contract`
- `BindingResolverPort` + `resolveLocalBindings` for offline local Camp dev-time resolution

Production promotion target (blocked on S1-13/S1-14 merge):

- `packages/core/src/ports/binding-resolver.ts`
- `packages/bindles/src/wiring/*`
- `packages/camps/*`, `packages/yards/*`
- `packages/runtimes/runtime-local/src/binding-resolver.ts`
- `examples/hello-bindle/*`

## Run

```sh
pnpm --prefix src/draft/technical-proofs/s1-15-bind-wiring-topology-contract test
pnpm --prefix src/draft/technical-proofs/s1-15-bind-wiring-topology-contract run typecheck
```

Regenerate golden manifest:

```sh
UPDATE_GOLDEN=1 pnpm --prefix src/draft/technical-proofs/s1-15-bind-wiring-topology-contract test
```

## Architecture Evidence

- `architecture/` — protobuf + CUE for wiring/topology records
- `architecture/pacts/` — manifest lowerer + runtime-local resolver boundaries
- `ADR.md` — parse-don't-validate + event-architecture evidence
