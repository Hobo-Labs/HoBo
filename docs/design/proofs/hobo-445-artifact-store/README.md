---
type: Reference
title: "HOBO-445 Artifact Store M0 Scope Proof"
description: "Source issue: HOBO-445."
tags: [hobo, design]
---

# HOBO-445 Artifact Store M0 Scope Proof

HOBO-445 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/artifact-store-scope-contract`](../../../../src/draft/exp-proofs/dx/artifact-store-scope-contract/README.md)
and the durable scope record at [artifact-store.md](../../artifact-store.md).

## Acceptance Evidence

- Goal and personas are explicit for release engineers, platform engineers, security reviewers,
  support operators, and customer admins.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Artifact classes cover wasm components, OCI images, resource packs, offline bundles, release
  assets, and generated provider artifacts.
- Custody states define declared, accepted, retained, yanked, expired, and quarantined outcomes.
- Required evidence fields cover artifact identity, digest and size, provenance link, retention
  class, access policy, yank invalidation, support/debug handoff, and customer assurance boundary.
- Dependencies map Provenance & Retention, Release Engineering, Registry & Distribution, Package
  Cache, Capability Review & Approval, Support Workflow, ADR-0062, ADR-0073, and ADR-0085.
- M1 evidence is listed as artifact record schema, custody state machine, retention policy matrix,
  access policy contract, yank invalidation fixture, support/debug handoff, and customer assurance
  summary.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects production blob store/lifecycle work, registry or resolver
  implementation, signing/KMS work, live release pipelines, UI, support automation, and customer
  data or tenant backup storage.
- Evidence validation rejects records missing required artifact evidence such as access policy.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Gate Evidence

- TypeScript proof: `pnpm --prefix src/draft/exp-proofs/dx/artifact-store-scope-contract test`.
- Protobuf/CUE proof: `pnpm test:schema` checks repository schema validators; package-local data-model folders own data model
  contracts including `ArtifactStoreScopeRecord`.
- PACT proof: `architecture/pacts/artifact_store_scope.pact.json` pins the M0 scope acceptance
  consumer expectations.
