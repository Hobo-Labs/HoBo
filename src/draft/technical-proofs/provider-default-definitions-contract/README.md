# Provider default Resource Definitions POC

Independent POC for HOBO-93.

This package pins the contract that a provider package ships one catch-all Resource Definition per supported capability. The defaults are built from the provider equivalence map plus its `realize()` output, then `.register(provider)` contributes them to the catalog consumed by Matching. Platform-authored `defineResource(...)` overrides are not a separate bootstrap path; they win through the same specificity score.

The POC covers:

- Provider registration emits `match: {}` defaults for `database`, `objectStore`, and `compute`.
- The Control-Plane scorer fixture selects a default when no override exists.
- Explicit platform definitions with more matching dimensions outscore defaults.
- Unsupported ports produce remediation input instead of fake defaults.
- Invalid provider claims fail closed before registration is trusted.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Default Definitions Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
