# Matching Specificity Vectors

Executable HOBO-55 spike vectors for [ADR-0088](../../../../docs/design/adr/01-architecture-core.md#adr-0088).

This draft package pins the matching comparator that feeds the future HOBO-64 engine:

- filter definitions by exact criteria match;
- rank by grouped specificity score and detail vector;
- then priority, selected objective, and stable definition id;
- record a catalog hash so true-tie winner changes caused by catalog edits are attributable.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\matching-specificity-vectors test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Matching Specificity Vectors.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
