# Distributed Artifact Version Policy POC

This POC pins the M0 distributed-artifact version policy for HOBO-336.

It defines:

- accepted version range syntax for distributed artifacts
- immutable Bindle pin checks over `(name, version, digest)`
- tier-aware compatibility verdicts for `stable`, `preview`, `experimental`, and `deprecated`
- deprecation-window transitions to `unservable`
- deterministic semver build-metadata normalization

Scope intentionally stops before resolver search/selection, upcaster implementation, yank lifecycle implementation, and CLI behavior. Those remain separate slices.

## Verification

Run the focused contract suite:

```bash
npm.cmd --prefix src\draft\technical-proofs\distributed-artifact-version-policy test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Distributed Artifact Version Policy.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
