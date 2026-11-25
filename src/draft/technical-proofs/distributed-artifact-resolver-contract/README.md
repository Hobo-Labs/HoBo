# Distributed Artifact Resolver Contract

HOBO-370 proves the version/compat resolver boundary for distributed artifacts.
It consumes the HOBO-340 spike vectors as compatibility fixtures and exposes a
production-shaped pure function:

```js
resolveDistributedArtifacts({
  mode: "install" | "plan" | "upgrade",
  requests,
  catalog,
  currentPins,
  lockPins,
  now,
  upcasters,
});
```

The resolver returns either a deterministic conflict or a pinned digest set plus
`hobo.manifest/v1` artifact pin records. Floating ranges are resolved against a
canonical catalog snapshot and frozen to immutable `{ name, version, digest }`
records.

## Scope

Included:

- Highest-compatible selection, ordinary-plan pin preservation, explicit
  upgrade, transitive dependency intersections, deterministic conflicts,
  deprecation-window filtering, and catalog-order invariance from HOBO-340.
- Fixed-point re-selection when a late transitive constraint narrows an already
  selected compatible root pin.
- Full lockfile/manifest pin-set mismatch rejection.
- Preview/experimental bump rejection unless an explicit upcaster is provided.
- In-place mutation refusal for existing immutable manifest pins during
  ordinary `plan`.
- Catalog-snapshot presence checks before preserving an immutable manifest pin.

Excluded:

- Cost tie-breaks across mirrors.
- Upcaster codemod execution.
- Yank lifecycle modeling.
- Install-time signature/provenance verification.
- Air-gap import.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\distributed-artifact-resolver-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Distributed Artifact Resolver Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
