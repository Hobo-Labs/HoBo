# HOBO-88 SDK Codegen Surface Proof

HOBO-88 is proven by the focused POC at
`src/draft/technical-proofs/sdk-codegen-surface-contract`.

## Acceptance Evidence

- `generates the checked-in SDK surface from WIT, Zod, allow scopes, and the
  bindle graph` proves the generated `ctx.bindings`, hooks, workflow/step
  signatures, provider `.with()` options, `api` tree, protobuf descriptors, Zod
  validators, and MCP parity manifest.
- `editing an allow scope changes generated bindings deterministically` proves
  `.allow()` edits are reflected in checked-in generated declarations.
- `codegen --check and MCP parity pass on fresh output and fail on stale output
  without mutation` proves drift detection and agent parity at the engine seam.
- The package `test:types` script writes generated declarations and compiles a
  consumer fixture with `tsc --noEmit`.

## Adversarial Evidence

- `coverage gaps fail closed instead of emitting any-typed clients` covers the
  collection-coverage exception from the SDK docs.
- `same sources generate byte-identical output independent of input ordering`
  covers ordering and locale flake risk.
- Raw escape hatches are generated as `unknown` plus a portability marker, never
  as `any`.
- `generated tree comparison records added, changed, and deleted paths
  deterministically` covers stale checked-in generated files.

## Scope Boundary

This proof owns the SDK codegen surface. It does not reimplement the HOBO-152 CLI
wrapper, `hobo dev` watch mode, `hobo build` integration, or production WIT/jco
generation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\sdk-codegen-surface-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
```
