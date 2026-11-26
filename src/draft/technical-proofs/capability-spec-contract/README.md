# Capability Spec Contract POC

This POC pins the M0 `hobo.capability-spec/v1` contract for HOBO-343.

It defines:

- A provider-published Capability Spec listing exact WIT `interface` + `semver` + stability tier.
- Per-interface `@hobo/conformance` suite versions and digest-pinned report references.
- Optional sibling hints for cost/availability facts already carried by the Capability Manifest.
- A pure `resolveAvailability(usedInterfaces, registeredSpecs)` helper over a catalog snapshot.

Resolution is deterministic and fail-closed: `stable` returns `ok`, `preview`/`experimental`/`deprecated` returns `warn`, unavailable or invalidly evidenced declarations return `error` with remediation.

Scope intentionally stops before MCP discovery indexing, continuous re-verification after publish, report generation, and install-time signature/provenance verification. Those remain separate slices.

## Verification

Run the focused contract suite:

```bash
npm.cmd --prefix src\draft\technical-proofs\capability-spec-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Capability Spec Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
