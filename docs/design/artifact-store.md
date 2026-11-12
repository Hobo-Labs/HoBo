---
type: Reference
title: "Artifact Store Scope And Acceptance"
description: "Source issue: HOBO-445."
tags: [hobo, design]
---

# Artifact Store Scope And Acceptance

Source issue: HOBO-445.

Executable proof lives in
[`src/draft/exp-proofs/dx/artifact-store-scope-contract`](../../src/draft/exp-proofs/dx/artifact-store-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-445-artifact-store`](./proofs/hobo-445-artifact-store/README.md).

## M0 Acceptance Record

Artifact Store exists to define launch-critical artifact custody evidence before storage, registry,
package cache, release, support, or customer assurance work depends on it. The record names artifact
classes, custody states, required evidence fields, access boundaries, owners, and M1 proof
expectations. It is not a production blob store, registry backend, package cache, signing-key
system, release pipeline, UI, support automation, or customer-data storage program.

## HoBo.CD: the delivery artifact store

The `@hobo/cd` artifacts module is the artifact store for delivery ([ADR-0180](./adr/01-architecture-core.md#adr-0180) D3,
D18; [continuous-delivery.md](./continuous-delivery.md)):

- **Content-addressed.** Artifacts and resolved-plan blobs are stored and
  fetched by digest; a reconciler fetches the resolved plan for a Delta by
  digest (inline on the delivery feed up to 256 KiB).
- **Integrity.** A blob whose bytes no longer match its digest is detected and
  blocks promotion; nothing is substituted.
- **Provenance.** in-toto Statement v1 + SLSA provenance, parsed by
  `@hobo/registry` and verified as a Sigstore bundle or a HoBo-signed
  attestation, is stored with the Freight it proves.
- **Retention.** Keep any Freight deployed anywhere, the configured number of
  predecessors per Camp, and anything under a legal hold; retire unpromoted
  Freight after 30 days (`freight.Retired`) and delete unreferenced blobs after
  7 days (`artifact.Deleted`).
- **Backends.** A filesystem store by default and an S3-compatible store when
  configured (`packages/hobo/CD.md`). Mirrors may serve an artifact from a
  local registry, but the digest never changes.
- **Runbook:** [artifact store](../runbooks/cd/artifacts.md).

## User And Business Goal

HoBo needs accepted M0 scope for Artifact Store so release engineers, platform engineers, security
reviewers, support operators, and customer admins know which artifacts are retained, why they are
trusted, who may access them, how yanks are explained, and which evidence must exist before later
implementation work fan-outs.

## Primary Personas

| Persona | Need |
|---|---|
| Release engineer | Needs artifact classes, provenance links, retention rules, and yank expectations before release workflows depend on storage evidence. |
| Platform engineer | Needs stable artifact identities, custody states, and access contracts before building storage or package-cache adapters. |
| Security reviewer | Needs digest, provenance, access-policy, quarantine, and customer-data boundaries without owning signing-key implementation. |
| Support operator | Needs support-safe artifact lookup, yank explanation, and debug handoff evidence without live debug collection. |
| Customer admin | Needs assurance wording that states which artifacts are retained, why they are trusted, and which evidence remains unavailable. |

## Scope In

- Define artifact classes for wasm components, OCI images, resource packs, offline bundles, release
  assets, and generated provider artifacts.
- Record required evidence fields for artifact identity, digest and size, provenance link,
  retention class, access policy, yank invalidation, support handoff, and customer assurance
  boundary.
- Define custody states for declared, accepted, retained, yanked, expired, and quarantined
  artifacts.
- Map service, UX, security, and support boundaries for artifact custody evidence and downstream
  handoffs.
- List owning initiative dependencies across Provenance & Retention, Release Engineering, Registry
  & Distribution, Package Cache, Capability Review & Approval, and Support Workflow.
- List M1 evidence required before artifact storage, package cache, registry integration,
  support/debug, or customer assurance work can depend on this record.

## Scope Out And Non-Goals

- Do not build a production blob store, lifecycle worker, storage engine, or object-storage adapter.
- Do not implement a registry backend, distributed resolver, package cache, registry mirror, or
  listing service.
- Do not implement signing keys, KMS, SLSA signer, certificate issuance, or key rotation.
- Do not build live release pipelines, package publishing jobs, release automation, or customer
  assurance export jobs.
- Do not build artifact browser UI, retention dashboards, customer-facing screens, or support
  consoles.
- Do not implement support ticket automation, helpdesk integration, support queues, or live debug
  collection.
- Do not store customer data snapshots, tenant backups, provider credentials, or live tenant data.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

Non-goals:

- Build the artifact store, registry backend, package cache, or blob lifecycle implementation.
- Replace artifact signing, SBOM, vulnerability, registry trust-tier, or release provenance
  decisions.
- Guarantee legal retention or customer assurance outcomes before security, privacy, and compliance
  owners accept evidence.
- Publish customer-facing assurance claims before every claim maps to a retained evidence source.
- Create follow-up implementation issues before the M0 scope record is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Artifact Store owns artifact classes, custody states, evidence fields, and the follow-up gate; storage services remain later work. |
| UX | UX scope is future customer-safe labels, assurance status, yank explanations, and support handoff evidence, not product screens. |
| Security | Security scope names digest, provenance, access-policy, quarantine, and redaction evidence without implementing signing keys or live enforcement. |
| Support | Support receives lookup facts, retained evidence, yanked-artifact explanation, and escalation handoff without support tooling. |

## Artifact Classes

| Class | Evidence shape | Out of scope |
|---|---|---|
| Wasm component | WIT package identity, digest, provenance link, and compatibility evidence. | Component build system, component host, runtime storage adapter, or SDK codegen. |
| OCI image | Image digest, source revision, build attestation, and runtime support boundary. | Image builder, registry backend, scanner, or deployment pipeline. |
| Resource pack | Signed descriptor, conformance evidence, and trust-tier handoff. | Capability review UI, provider registry, pack signing, or policy authoring. |
| Offline bundle | Manifest-complete digest set, revocation snapshot, and unsupported online dependency flags. | Air-gap import implementation, mirror synchronization, or resolver. |
| Release asset | CLI, SDK, manifest, or release packet retained for upgrade, rollback, support, and customer assurance review. | Release pipeline, updater, release approval, or package publishing. |
| Generated provider | Material digest, model/toolchain id, conformance refs, and certification state. | Generation loop, model selection, eval runner, or certification workflow. |

## Custody States

| State | Meaning |
|---|---|
| Declared | Artifact identity and expected evidence are declared but not accepted for use. |
| Accepted | Required evidence exists and consumers may depend on the artifact class within stated limits. |
| Retained | Artifact evidence is retained for the declared retention class and support boundary. |
| Yanked | Artifact remains explainable but is no longer selectable for new install or release paths. |
| Expired | Retention window closed and customer/support claims must route to limitation language. |
| Quarantined | Security or integrity concern blocks use until a human owner accepts remediation evidence. |

## Required Evidence Fields

| Field | Owner | Proof |
|---|---|---|
| Artifact identity | Artifact Store | Names artifact class, stable id, version, source owner, and digest namespace. |
| Digest and size | Artifact Store | Records digest algorithm, digest value, size, and immutable content boundary. |
| Provenance link | Provenance & Retention | Links source revision, build attestation, publish actor, and retained provenance evidence. |
| Retention class | Provenance & Retention | Names retention class, default window, customer visibility, and legal/privacy handoff. |
| Access policy | Security Verification | Names who can publish, read, yank, debug, export, and view customer-facing assurance evidence. |
| Yank invalidation | Release Engineering | Records affected artifact, reason, replacement guidance, cache invalidation, and support note. |
| Support/debug handoff | Support Workflow | Names redacted support-safe fields and escalation owner without granting live storage control. |
| Customer assurance boundary | Capability Review & Approval | Maps customer-facing claims to retained evidence sources and unavailable-evidence wording. |

## Authoritative Dependencies

- [provenance-retention.md](./provenance-retention.md) owns artifact provenance evidence classes,
  retention policy, audit export, support handoff, and assurance claim sources.
- [release-artifact-provenance-retention.md](./release-artifact-provenance-retention.md) owns
  release artifact handoff classes, invalidation/yank handling, and support/debug access posture.
- [sbom-vulnerability-notice-evidence.md](./sbom-vulnerability-notice-evidence.md) owns SBOM,
  vulnerability, notice, and customer assurance evidence classes.
- [platform-engineering.md#plan-25](./platform-engineering.md#plan-25) owns resource packs,
  registry distribution surfaces, and platform-engineering package handoffs.
- [contracts-policy-flags.md#plan-29](./contracts-policy-flags.md#plan-29) owns policy and
  contract gates that later consume artifact access and assurance evidence.
- [technical-standards.md](./technical-standards.md) owns TypeScript, Protobuf, CUE,
  parse-don't-validate, and PACT evidence expectations for this proof package.
- [ADR-0062](./adr/07-portability-extensibility.md#adr-0062) pins registry distribution and trust
  expectations for signed bundles and conformance metadata.
- [ADR-0073](./adr/07-portability-extensibility.md#adr-0073) pins Artifact Repo as a port, keeping
  repository implementation outside this M0 scope.
- [ADR-0085](./adr/01-architecture-core.md#adr-0085) owns vendored interface and artifact hash
  pinning posture.

## Owning Initiative Dependencies

| Owner | Consumes from Artifact Store | Boundary |
|---|---|---|
| Artifact Store | Artifact classes, custody states, evidence fields, M1 proof checklist, and follow-up gate. | This issue defines the scope record; it does not build storage, registry, cache, signer, UI, or support workflows. |
| Provenance & Retention | Provenance, retention, audit, redaction, and assurance evidence. | Storage, signing, and live enforcement remain outside this M0 record. |
| Release Engineering | Release ids, publish/yank decisions, release evidence, and replacement guidance. | Release pipeline, go/no-go, and publishing automation remain separate. |
| Registry & Distribution | Artifact descriptors, offline bundle metadata, and trust-tier history. | Registry backend, mirror, resolver, and listing workflow remain separate. |
| Package Cache | Digest and invalidation facts. | Cache implementation, dependency closure, and package metadata retention remain separate. |
| Capability Review & Approval | Customer assurance and trust evidence. | Approval UI, policy authoring, and capability review workflow remain outside this record. |
| Support Workflow | Support-safe lookup, yank, dispute, and debug evidence. | Ticket routing, incident tooling, and live debug collection remain separate. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Artifact record schema | Artifact Store | Contract test | Artifact records carry class, identity, digest, provenance, retention, and access evidence. |
| Custody state machine | Artifact Store | Contract test | Declared, accepted, retained, yanked, expired, and quarantined states are stable and fail closed. |
| Retention policy matrix | Provenance & Retention | Design record | Retention class, default window, customer visibility, and legal/privacy handoff are explicit. |
| Access policy contract | Security Verification | Policy contract | Publish, read, yank, debug, export, and assurance visibility decisions are bounded. |
| Yank invalidation fixture | Release Engineering | Reference fixture | Yank decisions retain lineage, replacement guidance, cache invalidation, and support wording. |
| Support/debug handoff | Support Workflow | Support handoff | Support can inspect redacted artifact evidence without raw customer data or live storage control. |
| Customer assurance summary | Capability Review & Approval | Customer assurance | Customer-facing assurance claims map to retained evidence or explicit unavailable sections. |

## Follow-Up Gate

M1/M2/M3/M4 Artifact Store design or implementation issues must wait until this M0 scope record is
accepted. This branch records the gate and its executable guard; it does not create follow-up
implementation issues.
