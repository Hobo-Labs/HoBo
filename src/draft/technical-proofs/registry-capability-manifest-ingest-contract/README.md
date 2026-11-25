# Registry Capability Manifest Ingest Contract

HOBO-630 draft POC for `@hobo/registry`: ingest and signature-verify provider Capability
Manifests from `/.well-known/capability-manifest/`, index capabilities/auth/cost, expose
capability search, and store plugin records with provenance and conformance reports.

Promotes the catalog slice of
[`portability-registry-distribution`](../../epic-proofs/portability-registry-distribution/README.md)
and manifest fixtures from
[`providers-iac-build-adapters`](../../epic-proofs/providers-iac-build-adapters/README.md).

## BDD scenarios

```gherkin
Feature: Capability manifest ingest

  Persona: Registry operator

  Scenario: Ingest a signed well-known bundle
    Given a provider publishes index.json, capabilities.json, auth.json, and cost.json
    When the registry ingests the well-known bundle with a verified signature
    Then capabilities, auth, and cost are indexed for search
    And a plugin record stores provenance and conformance
```

```gherkin
Feature: Registry events

  Persona: Control-plane auditor

  Scenario: First provider registration emits lifecycle events
    Given a signed capability manifest has not been ingested before
    When ingest succeeds
    Then ProviderRegistered and CapabilityManifestUpdated events are appended
```

```gherkin
Feature: Planner capability source

  Persona: Planner engineer

  Scenario: Cloudflare manifest feeds planner search
    Given the Cloudflare provider publishes its capability manifest
    When the registry ingests it from the well-known path
    Then the planner capability source lists hobo:runner and hobo:kv entries from the registry
    Instead of local planner fixtures
```

## Scope

In scope:

- `createCapabilityRegistry()` in-memory registry with ingest, search, and event projection.
- `ingestWellKnown()` signature verification, document digest checks, and manifest validation via
  [`provider-capability-manifest-contract`](../provider-capability-manifest-contract/README.md).
- `searchCapabilities()` capability search by port, region, and features.
- `createPlannerCapabilitySource()` so planners read registry-indexed capabilities.
- `buildCloudflareWellKnownBundle()` adapter for the S2-08 Cloudflare manifest fixture.

Out of scope:

- Production `packages/registry/` transport, persistence, or HTTP server.
- OCI artifact push/pull (see [`oci-artifact-storage-contract`](../oci-artifact-storage-contract/README.md)).
- Live provider crawlers or external registry egress.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/registry-capability-manifest-ingest-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Maintenance

Source issue: HOBO-630 (S3-04). Gates: TypeScript contract tests, architecture guard, PACT fixture.
2026-07-02 merge repair: refreshed `pnpm-lock.yaml` workspace importers after merging
`origin/main`; rerun this package's direct package test before branch-level validation.
