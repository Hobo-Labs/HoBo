# hobo:artifact-repo Port Contract POC

This POC pins the M0 `hobo:artifact-repo@0.1.0` contract for HOBO-347.

It defines:

- `pull(coordinate) -> verified-artifact` with digest-pinned artifact references.
- `publish(artifact, provenance) -> ref` with required digest-pinned provenance.
- Registered adapter kinds for npm, NuGet, PyPI, OCI, Maven, Cargo, and RubyGems.
- A mirror-set abstraction that only contains registered adapters.
- A conformance stub asserting the digest-pinned pull and provenance-required publish invariants.

Scope intentionally stops before signature/provenance verification enforcement, digest-as-selection-key mirror selection, air-gap import/mirroring, concrete adapter implementations, and CLI behavior.

## Verification

Run the focused suite:

```bash
npm.cmd --prefix src\draft\technical-proofs\artifact-repo-port-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Artifact Repo Port Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
