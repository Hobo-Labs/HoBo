# Platform Engineer Flow Contract

HOBO-203 proof package for the platform engineer user story:

- register a fake provider with default ResourceDefinitions
- map a Camp to a provider and IaC driver
- plan a SnapShop manifest through Matching
- realize the resulting topology through `hobo up ./platform`
- query every resolution by resource id

The package is intentionally local to `src/draft/`. It does not implement the
real CLI or provider runtime; it proves the branch-visible contract that the
same app manifest can be planned and realized through platform-owned provider
defaults and overrides.

## Verification

```powershell
npm.cmd --prefix src/draft/technical-proofs/platform-engineer-flow-contract test
```

The test suite covers the acceptance path plus adversarial cases for missing
capability definitions, colliding overrides, unapproved inferred provider
defaults, and unknown Camp/provider names.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Platform Engineer Flow Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
