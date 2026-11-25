# Version Pinning Drift Guard Contract

This POC pins HOBO-395's adversarial guard for immutable distributed-artifact
pins under floating ranges, preview bumps, and deprecation-window expiry.

## Contract Surface

- `planPinnedRedeploy` models an ordinary redeploy of an existing Bindle
  version. It preserves the manifest pin even when a higher preview release is
  present in the catalog.
- `planPinnedRedeploy` refuses an expired deprecated pin with
  `redeploy-blocked-unservable-pin`, keeps the running pin unchanged, and
  returns a migration prompt.
- `adoptPreviewBumpAsNewBindleVersion` models explicit adoption of a preview
  bump. It requires a new Bindle version, an explicit upcaster edge, and a
  passing conformance report.

## Boundary

This package reuses the existing distributed-artifact version policy and
resolver contracts. It does not implement resolver search, upcaster codemods,
yank lifecycle behavior, host-version pinning, registry transport, or CLI
commands.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\version-pinning-drift-guard-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Version Pinning Drift Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
