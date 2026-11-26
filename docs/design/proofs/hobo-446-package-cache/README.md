---
type: Reference
title: "HOBO-446 Package Cache M0 Scope Proof"
description: "Source issue: HOBO-446."
tags: [hobo, design]
---

# HOBO-446 Package Cache M0 Scope Proof

HOBO-446 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/package-cache-scope-contract`](../../../../src/draft/exp-proofs/dx/package-cache-scope-contract/README.md)
and the durable scope record at [package-cache.md](../../package-cache.md).

## Acceptance Evidence

- Goal and personas are explicit for release engineers, platform engineers, security reviewers,
  support operators, and self-host/offline admins.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Cache subjects cover npm packages, WIT interfaces, wasm components, OCI artifacts, and offline
  bundles.
- Required evidence fields cover package coordinate, digest, source registry, provenance ref, SBOM
  ref, vulnerability state, invalidation policy, retention class, offline availability, and support
  handoff.
- Result states define cacheable, blocked, unsupported, quarantined, invalidated, and
  needs-manual-review outcomes.
- Dependencies map Package Namespaces, Release Artifact Provenance, SBOM/Vulnerability, Bootstrap
  Installer, Compatibility Matrix, Security Verification, Support SLA/Channels, Tenant Data
  Lifecycle, ADR-0062, ADR-0095, ADR-0023, and ADR-0082.
- M1 evidence is listed as cache subject matrix, digest lock fixtures, invalidation contract,
  offline cache manifest, security quarantine rules, support debug record, and retention policy map.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects registry backend, live package mirror, installer/bootstrap/package-manager
  clients, vulnerability approval, support automation, and live-network package fetch creep.
- Evidence validation rejects records missing required package cache evidence such as digest.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Gate Evidence

- TypeScript proof: `pnpm --prefix src/draft/exp-proofs/dx/package-cache-scope-contract test`.
- Protobuf/CUE proof: `src/draft/exp-proofs/dx/package-cache-scope-contract/architecture/package_cache_scope.proto`
  and `src/draft/exp-proofs/dx/package-cache-scope-contract/architecture/package_cache_scope.cue` pin the local
  `PackageCacheScopeRecord` shape and constraints.
- PACT proof: `architecture/pacts/package_cache_scope.pact.json` pins the M0 scope acceptance
  consumer expectations.
