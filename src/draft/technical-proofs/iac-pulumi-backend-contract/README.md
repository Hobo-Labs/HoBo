# @hobo/iac-pulumi Automation API backend contract

Independent proof for HOBO-131. The package models the `@hobo/iac-pulumi`
backend as an embeddable Automation API adapter over an `IacProgram`, with no
CLI shell-out path.

## Proven behavior

- `preview(program)` returns a typed `Diff` with fixture create changes and a
  clean result after convergence.
- `apply(program)` returns resource outputs and stack outputs for binding
  resolution.
- `refresh(program)` reports an empty drift report for a converged stack.
- `destroy(program)` removes the fixture resources and returns destroyed
  outputs.
- `apply -> preview` is idempotent; the second preview is empty.
- Pulumi Automation API version drift fails before adapter construction.
- Preview/apply non-determinism, partial apply state, and unresolved output
  references are surfaced as explicit contract errors.

## Scope boundaries

This is a contract POC, not the real Pulumi engine. It intentionally uses an
in-memory Automation API fixture so the acceptance loop can run offline and
prove the backend port shape before the production package is scaffolded.
Per-resource stacks, OpenTofu/Crossplane/CDKTF, Firecracker execution, and the
shared `IacProvider` port type remain outside this slice.

## Check

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-pulumi-backend-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Iac Pulumi Backend Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
