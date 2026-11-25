# HOBO-5 Conformance Harness Proof

HOBO-5 is proven by the focused POC at
[`src/draft/technical-proofs/conformance-port-suite-contract`](../../../../src/draft/technical-proofs/conformance-port-suite-contract/README.md).

Acceptance mapping:

- Toy port plus toy adapter passes through `runConformanceSuite`, while a broken adapter fails with a precise JSON-path diff.
- Reports carry suite, port, adapter, seed, and case provenance plus a `listed`/`blocked` claim disposition for CI consumers.
- Golden-IR mismatch and replay-trace regression are separate report failures.
- Coverage output lists exercised and required functions, and claimed-but-unexercised functions fail the suite.
- Seeded determinism rejects nondeterministic adapter behavior.
- The SDK parity lane rejects language-specific golden IR and missing semantics-annex vectors.

Scope note: this proof defines the harness/report contract only. Real port suites, provider certification, CI unlisting, and artifact signing remain owned by downstream slices.

S1-10 (`packages/conformance/src/suites/runtime-port` + `component-host`, HOBO-599) promotes the runtime-port durability and component-host portability suites to production. Draft epic evidence remains at `src/draft/epic-proofs/s1-10-conformance-trust-boundary/`.

Focused verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\conformance-port-suite-contract test
```
