# HOBO-156 Build CLI Contract

This package is an independent POC for the `hobo build` contract. It composes
the existing codegen and componentize draft packages and proves the build-level
orchestration rules without implementing production jco, Dagger, push,
provisioning, signing, or attestation.

## Proven Behavior

- `hobo build --json` emits a build manifest plus artifact descriptors with
  content digests.
- TypeScript services componentize to wasm component artifacts.
- Non-wasm guests fall back to OCI-container artifacts only with a recorded
  reason.
- `HOBO_RUNTIME=container` forces wasm-capable services through the OCI fallback
  path and records the target hint.
- Numeric `SOURCE_DATE_EPOCH` values are accepted as Unix seconds and normalized
  before artifact manifests are written.
- Repeated builds and clean checkouts produce stable artifact digests.
- Stale `_generated/` files fail before build output with a regeneration hint.
- Componentization failures name the service and cause and do not write a build
  manifest.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-build-cli-contract test
```

The Stage Gate S0 runner exercises this proof with `SOURCE_DATE_EPOCH=1704067200`
so Windows and CI use the same reproducible timestamp input.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Build Cli Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
