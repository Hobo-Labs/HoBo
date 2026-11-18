# SDK conformance fixtures

This project exercises `@hobo/conformance/sdk` with a deterministic lowering
corpus, semantics vectors, and reference and drifted adapters. The shared gate
checks lowering equivalence, semantics, idiom-layer boundaries, authorship, and
coverage claims. Reports are bounded by the supplied corpus.

Run `pnpm --prefix src/draft/projects/s1-24-conformance-sdk test` to execute the
fixtures. `examples/usage.ts` demonstrates passing, divergent, and uncovered
cases using the production gate.
