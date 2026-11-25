# HOBO-392 Local Dev/Test Authoring Proof

This proof package lives at `src/draft/technical-proofs/local-dev-test-authoring-contract`.

It covers the HOBO-392 acceptance surface:

- `testRuntime()` starts the checkout workflow, resumes a hook, advances deterministic time, and proves replay state equals live state.
- Every `@hobo/bindles` catalog resource resolves to a local Camp equivalent without importing or naming a provider symbol.
- Dev-only secret sources are marked non-production and cannot satisfy production `can-deploy`.
- Negative tests cover ambient nondeterminism, CI prompt skipping, and resources without local equivalents.

Scope kept out: the `@hobo/runtime-local` engine internals, EventStore/Queue/Clock implementations, provider fakes, brokered production secret resolution, and the `hobo dev` CLI watch/serve loop.
