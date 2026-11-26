# Release Artifact Provenance Retention Contract

Independent POC for HOBO-504. It pins the M0 release artifact provenance and
retention handoff before artifact-store implementation begins.

## Contract Surface

- `RELEASE_ARTIFACT_PROVENANCE_RETENTION` is versioned as
  `hobo.release-artifact-provenance-retention/v1`.
- Required artifact classes cover SaaS releases, self-host/offline bundles, CLI releases,
  package releases, registry listings, generated provider artifacts, and customer assurance
  packets.
- Each artifact class must define provenance source, retention period, invalidation/yank handling,
  offline bundle expectation, and support/debug access.
- Handoff owner lanes link release engineering, artifact store, package cache, registry,
  compliance, and support.
- Known gaps are classified as beta limitation, GA blocker, or post-GA follow-up.

## Scope Boundaries

Included:

- Deterministic M0 release artifact handoff fixture and validator.
- Owner-lane mapping for release, artifact, package, registry, compliance, and support handoffs.
- Negative guards for artifact-store implementation scope creep and unclassified gaps.

Excluded:

- Artifact store, package cache, registry backend, or production retention implementation.
- Live release pipeline, customer assurance export job, or support/debug tooling.
- Replacement of SBOM/vulnerability notices, legal/privacy, or registry trust-tier contracts.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\release-artifact-provenance-retention-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Release Artifact Provenance Retention Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
