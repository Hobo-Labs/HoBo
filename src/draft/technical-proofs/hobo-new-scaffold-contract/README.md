# hobo new Scaffold Contract POC

HOBO-118 proof for `hobo new <name> [-t todo|api|agent|fullstack]`.

> **Promotion (S1-20 / HOBO-610):** scaffold behavior is implemented in production package [`packages/cli`](../../../../packages/cli/) (`src/commands/new.ts`, `src/templates/`). This proof remains the contract reference for offline template constraints.

## What This Proves

- `hobo new <name> -t api --json` creates a minimal SDK project with `package.json`,
  `app.ts`, `app.test.ts`, `tsconfig.json`, `.hobo/` ignored, `hobo.bindle.json`, and
  checked-in `src/_generated/` seeds.
- All four templates produce runnable project stubs with `hobo dev`, `node --test`, and
  `tsc --noEmit` scripts.
- JSON output reports the exact created files and next commands.
- Human output prints the exact next commands:

```powershell
cd <name>
hobo dev
```

- Populated directories fail safely unless `--force` is used.
- Invalid templates and unsafe names fail without falling back to a default.
- Existing git repositories keep unrelated files untouched.
- Scaffolding is offline and never fetches registry-hosted templates.

## Boundary

This is an executable scaffold contract, not the production CLI integration or `hobo dev`
runtime. It does not implement the dev loop, registry-hosted templates, provider calls, or
real SDK codegen. The generated `_generated/` files are seed stubs so later CLI/runtime slices
can replace them with production bindings.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-new-scaffold-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo New Scaffold Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
