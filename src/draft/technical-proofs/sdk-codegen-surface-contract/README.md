# HOBO-88 SDK Codegen Surface Contract

This draft proves the SDK codegen engine surface from ADR-0037. It is separate
from the HOBO-152 CLI wrapper: this package owns the generated SDK artifacts and
source-to-output determinism, while HOBO-152 owns command-line drift protocol.

## Proven Surface

- WIT records, Zod schemas, `.allow()` scopes, and the bindle graph produce a
  checked-in `.hobo/generated/` plus `src/_generated/` tree.
- Generated artifacts include typed `ctx.bindings`, hooks, workflow/step
  signatures, provider `.with()` option types, an `api` function tree, protobuf
  descriptors, Zod validators, and an MCP parity manifest.
- Editing an `.allow()` scope changes generated bindings deterministically.
- `codegen --check` and the MCP tool report the same drift and do not mutate on
  failure.
- Raw escape hatches are generated as `unknown` plus a portability marker, never
  `any`.

## Adversarial Evidence

- Collection coverage gaps fail closed before any generated client is emitted.
- Reordered input maps/sets produce byte-identical output.
- Stale, added, and deleted generated files are reported deterministically.
- A generated consumer type-checks with `tsc --noEmit`.

## Scope Boundary

This package is a contract POC, not the production shared SDK generator. It does
not implement `hobo dev`, `hobo build`, watch mode, data-plane query runtime, or
the production WIT/jco compiler. It consumes those surfaces as fixtures.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\sdk-codegen-surface-contract install
npm.cmd --prefix src\draft\technical-proofs\sdk-codegen-surface-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sdk Codegen Surface Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
