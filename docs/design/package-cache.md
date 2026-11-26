---
type: Reference
title: "Package Cache Scope And Acceptance"
description: "Source issue: HOBO-446."
tags: [hobo, design]
---

# Package Cache Scope And Acceptance

Source issue: HOBO-446.

Executable proof lives in
[`src/draft/exp-proofs/dx/package-cache-scope-contract`](../../src/draft/exp-proofs/dx/package-cache-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-446-package-cache`](./proofs/hobo-446-package-cache/README.md).

## M0 Acceptance Record

Package Cache exists to define the launch-critical package evidence contract before follow-up cache,
mirror, installer, registry, security, support, or offline-bundle work depends on it. The record
names cache subject classes, required evidence fields, result states, owners, and scope guards. It
is not a production package cache, package mirror, registry backend, package-manager client,
vulnerability scanner, support workflow, artifact store, or live network fetch path.

## User And Business Goal

HoBo needs accepted M0 scope for Package Cache so release engineers, platform engineers, security
reviewers, support operators, and self-host/offline admins know which digest-pinned package evidence
must exist before v1 install, release, customer-assurance, or offline-bundle claims depend on cached
packages.

## Primary Personas

| Persona | Need |
|---|---|
| Release engineer | Needs retained package digests, provenance refs, and invalidation records before release notes or assurance packets cite cached package evidence. |
| Platform engineer | Needs deterministic cache subject classes, digest fixtures, and cacheability states before building a package-cache service. |
| Security reviewer | Needs SBOM, vulnerability, quarantine, and provenance evidence without turning this issue into a scanner or approval workflow. |
| Support operator | Needs cache miss, invalidation, yanked package, and unsupported package handoff fields without adding support automation. |
| Self-host/offline admin | Needs offline bundle package availability and anti-rollback evidence before self-host install paths depend on a cache. |

## Scope In

- Define cache subject classes for npm packages, WIT interfaces, wasm components, OCI artifacts, and
  offline bundles.
- Record required evidence fields for package coordinate, digest, upstream source, provenance, SBOM,
  vulnerability state, invalidation policy, retention class, offline availability, and support
  handoff.
- Define result states for cacheable, blocked, unsupported, quarantined, invalidated, and
  needs-manual-review package outcomes.
- Map service, UX, security, and support boundaries for package cache evidence and downstream
  handoffs.
- List owning initiative dependencies across Package Cache, Artifact Store, Portability Registry,
  Release Artifact Provenance, SBOM/Vulnerability evidence, Bootstrap Installer, Security
  Verification, and Support Workflow.
- List M1 evidence required before cache subject matrices, digest lock fixtures, invalidation
  contracts, offline manifests, quarantine rules, support debug records, or retention maps can
  depend on this record.

## Scope Out And Non-Goals

- Do not build a production package-cache service, mirror, CDN edge, local proxy, or package download
  runtime.
- Do not build a package publishing API, Registry storage, namespace ownership change, trust-tier
  decisioning, or marketplace listing mutation.
- Do not build an installer, `hobo install`, bootstrap path, package-manager client, or developer
  machine integration.
- Do not build a live vulnerability scanner, SBOM generator, malware scanner, package approval
  workflow, or legal notice generator.
- Do not build support ticket automation, helpdesk integration, customer notification workflow, SLA
  promise, or support queue.
- Do not fetch packages from the public internet, access live upstreams, persist credentials, scan
  customer packages, or access tenant data.
- Do not build retention stores, blob storage, artifact replication, offline bundle builders, or
  provenance signing runtime.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

Non-goals:

- Build a package cache, registry backend, proxy, package manager plugin, or artifact storage
  service.
- Replace package namespace ownership, registry distribution, artifact provenance retention, or SBOM
  evidence records.
- Approve vulnerability posture, legal notices, trust tiers, launch claims, or customer assurance
  wording.
- Fetch live packages, scan customer dependencies, persist credentials, or mutate release artifacts.
- Create downstream implementation issues before M0 Package Cache scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Package Cache M0 owns cache subject taxonomy, evidence fields, result states, and M1 proof expectations; runtime service and storage remain later work. |
| UX | UX scope is future customer-safe labels for cacheable, unavailable, invalidated, and unsupported packages across installer, release notes, and support surfaces, not implementation. |
| Security | Security scope names SBOM, vulnerability, quarantine, provenance, and anti-rollback evidence without scanner or approval implementation. |
| Support | Support receives cache miss reasons, invalidation handoff, unsupported/quarantined/manual-review states, and escalation owner without adding support tooling. |

## Cache Subject Classes

| Subject | Evidence shape | Out of scope |
|---|---|---|
| npm package | Published package coordinate with version, integrity digest, provenance ref, SBOM/notice refs, and invalidation status. | npm proxy, package publishing, namespace changes, package-manager client, or live fetch. |
| WIT interface | Vendored WIT interface or generated binding package pinned by digest, compatibility floor, and source provenance. | Toolchain vendoring changes, upcaster implementation, or WIT generation runtime. |
| wasm component | Built wasm component dependency with component digest, toolchain provenance, SBOM ref, and compatibility state. | Component build service, artifact signing runtime, or component host implementation. |
| OCI artifact | OCI artifact dependency referenced by immutable digest, provenance, retention class, and yank/invalidation behavior. | OCI registry backend, mirror service, blob retention, or pull-through cache. |
| Offline bundle | Self-host/offline dependency closure manifest with included package digests, unavailable classes, and anti-rollback metadata. | Offline bundle builder, installer implementation, or air-gap import runtime. |

## Required Evidence Fields

| Field | Owner | Proof |
|---|---|---|
| Package coordinate | Package Cache | Names package name, version or range, ecosystem, and owning package namespace rule. |
| Digest | Package Cache | Records immutable content digest or explicitly blocks cacheability when digest evidence is missing. |
| Source registry | Portability Registry | Names upstream source metadata and mirror eligibility without implementing registry storage. |
| Provenance ref | Release Artifact Provenance | Links signed build, generation, or publication provenance for release and support evidence. |
| SBOM ref | SBOM Vulnerability Notice Evidence | Links package inventory, third-party notice, and customer assurance evidence sections. |
| Vulnerability state | Security Verification | Records known, deferred, unavailable, quarantined, or manually reviewed vulnerability posture. |
| Invalidation policy | Package Cache | Defines yank, replacement, expiry, quarantine, and anti-rollback handling for the subject. |
| Retention class | Release Artifact Provenance | Maps package metadata and evidence retention to release, support, or customer assurance windows. |
| Offline availability | Bootstrap Installer | States whether the subject is included, excluded, or unavailable for self-host/offline bundles. |
| Support handoff | Support Workflow | Names cache miss, invalidation, unsupported, quarantine, or manual-review owner and next action. |

## Result States

| State | Meaning |
|---|---|
| Cacheable | All required evidence exists for a digest-pinned subject within the accepted retention and support class. |
| Blocked | A required digest, provenance, SBOM, security, retention, offline, or support evidence field is missing. |
| Unsupported | The package class is explicitly outside v1 support and must route to release notes or support limitations. |
| Quarantined | Security or notice evidence prevents use until a reviewer resolves, replaces, or accepts the risk. |
| Invalidated | A yank, replacement, digest mismatch, expiry, or anti-rollback event made prior cache evidence unusable. |
| Needs manual review | A human owner must evaluate provenance, vulnerability, notice, or support evidence before cacheability. |

## Authoritative Dependencies

- [package-namespaces.md](./package-namespaces.md) owns package/import ownership and namespace
  collision rules.
- [release-artifact-provenance-retention.md](./release-artifact-provenance-retention.md) owns
  provenance, retention, invalidation/yank, offline bundle, and support/debug evidence handoffs.
- [sbom-vulnerability-notice-evidence.md](./sbom-vulnerability-notice-evidence.md) owns SBOM,
  vulnerability, notice, and customer assurance evidence classes.
- [bootstrap-installer.md](./bootstrap-installer.md) owns SaaS, self-host, and local/dev install
  paths that consume offline package availability.
- [compatibility-matrix.md](./compatibility-matrix.md) owns CLI, platform, runtime, and package
  support routing.
- [security-verification.md](./security-verification.md) owns vulnerability, quarantine, blocker,
  waiver, and fix-verification posture.
- [support-sla-channels.md](./support-sla-channels.md) owns support channel, severity, unsupported
  request, escalation, and customer-safe response language.
- [tenant-data-lifecycle.md](./tenant-data-lifecycle.md) owns customer-data boundaries that package
  cache evidence must not cross.
- [ADR-0062](./adr/07-portability-extensibility.md#adr-0062) defines signed/certified registry
  distribution.
- [ADR-0095](./adr/07-portability-extensibility.md#adr-0095) defines distributed-artifact version
  resolution semantics.
- [ADR-0023](./adr/02-identity-security.md#adr-0023) requires security commitments to be verifiable
  gates.
- [ADR-0082](./adr/02-identity-security.md#adr-0082) pins Golden Suites as reproducible
  verification gates.

## Owning Initiative Dependencies

| Owner | Consumes from Package Cache | Boundary |
|---|---|---|
| Package Cache | Cache subject taxonomy, evidence fields, cacheability states, invalidation posture, M1 proof expectations, and follow-up gate. | This issue defines scope and acceptance; it does not build cache, mirror, registry, installer, scanner, support, or storage runtime. |
| Artifact Store | Durable artifact retention and blob ownership later. | Storage, replication, retention stores, and support/debug access are separate work. |
| Portability Registry | Registry descriptors, signed distribution, and version resolution. | Registry backend, publishing, listing mutation, and trust-tier decisioning remain separate. |
| Release Artifact Provenance | Provenance, retention class, yank, invalidation, and customer assurance handoff inputs. | Signing runtime and release approval remain separate. |
| SBOM Vulnerability Notice Evidence | SBOM, vulnerability, notice, and assurance sections consumed by cache evidence. | Scanner, notice generator, and formal compliance claims remain separate. |
| Bootstrap Installer | Offline availability and dependency closure evidence for self-host and local/dev install paths. | Installer, package fetch, and recovery implementation remain separate. |
| Security Verification | Quarantine and vulnerability posture. | Security approval, customer scanning, and live package scanning remain separate. |
| Support Workflow | Cache miss, invalidation, unsupported, quarantine, and manual-review records. | Support queues, SLAs, tickets, and customer notifications remain separate. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Cache subject matrix | Platform engineer | Cache subject classes | Design record | npm, WIT, wasm component, OCI artifact, and offline bundle subjects have accepted coverage rows. |
| Digest lock fixtures | Platform engineer | Digest field | Reference fixture | Cacheability requires immutable digests and rejects missing or mismatched digest evidence. |
| Invalidation contract | Release engineer | Invalidation policy | Contract test | Yank, replacement, expiry, quarantine, and anti-rollback outcomes are stable and fail closed. |
| Offline cache manifest | Offline admin | Offline availability | Manifest fixture | Self-host/offline package closure names included, excluded, and unavailable package classes. |
| Security quarantine rules | Security reviewer | Vulnerability state | Security fixture | Vulnerability, notice, provenance, and manual-review gaps route to blocked or quarantined states. |
| Support debug record | Support operator | Support handoff | Support handoff | Support can route cache misses, invalidations, unsupported classes, and manual-review states with owner and next action. |
| Retention policy map | Release engineer | Retention class | Policy map | Package metadata and evidence retention map to release, support, and customer assurance windows. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
