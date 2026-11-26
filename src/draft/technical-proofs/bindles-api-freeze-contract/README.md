# HOBO-399 Bindles API Freeze Contract

> **Promoted to `packages/bindles/` (S1-13 / HOBO-602).** The frozen public-API snapshot now lives at `packages/bindles/contracts/bindles-public-api.snapshot.json`.

This draft freezes the narrow `@hobo/bindles` public API and representative
`hobo.manifest/v1` IR contract described by the SDK API and authoring resource
design docs. It composes the existing predecessor POCs instead of reimplementing
the SDK, collection engine, XAA broker, raw driver, or manifest runtime.

## Proven Surface

- `@hobo/bindles` exported symbols and signatures are pinned by a public API
  snapshot fixture.
- Internal/provider-specific public type leaks are rejected by the snapshot
  guard.
- `.allow()` narrowing below observed usage fails through the usage-permission
  contract.
- Collection coverage gaps fail through the collection coverage gate.
- XAA scope inference stays least-privilege, and declared narrowing overrides
  fail when observed usage exceeds them.
- Raw driver `.raw()` usage carries `RAW_DRIVER_PORTABILITY_DEBT`.
- Provider `.with()` options stay inert for non-resolved providers.
- A representative Bindle pins `hobo.manifest/v1` golden shape, including raw
  edge, XAA, and provider-option annotations.

## Adversarial Evidence

- A camel-cased provider/internal type leak such as `AwsRdsInternalOptions` is
  caught.
- Adding a manifest field without changing the schema version raises
  `MANIFEST_SCHEMA_VERSION_REQUIRED`.
- The combined narrowing-plus-coverage regression asserts both failure codes in
  one test case.

## Scope Boundary

This package is a hardening POC only. It does not add SDK features, runtime
providers, CLI namespace changes, conformance parity gates, GA docs, or
changelog output.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\bindles-api-freeze-contract test
```

The test runs through `tsx` because it intentionally imports the neighboring
`hobo-bindles-resource-catalog` TypeScript source after the draft taxonomy move.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Bindles Api Freeze Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
