# HoBo Contract IR draft

Independent POC for `HOBO-116`.

This package pins the `contract.ir/v1` shape for Plan 29:

- contracts are carried on manifest graph edges, not stored as external test files;
- modes are `declared`, `inferred`, `observed`, and `promoted`;
- declared/inferred contracts are verified by construction;
- observed/promoted contracts are confidence-bounded and carry sample coverage;
- OpenAPI, Pact, AsyncAPI, and Protobuf are import/export targets over the IR, not the source of truth.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-contract-ir test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Contract Ir.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
