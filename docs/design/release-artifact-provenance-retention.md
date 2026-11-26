---
type: Reference
title: "Release Artifact Provenance And Retention"
description: "Source issue: HOBO-504."
tags: [hobo, design]
---

# Release Artifact Provenance And Retention

Source issue: HOBO-504.

Executable proof lives in
[`src/draft/technical-proofs/release-artifact-provenance-retention-contract`](../../src/draft/technical-proofs/release-artifact-provenance-retention-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-504-release-artifact-provenance-retention`](./proofs/hobo-504-release-artifact-provenance-retention/README.md).

## M0 Acceptance Record

Release artifact provenance and retention is the handoff between release engineering, artifact
storage, package/cache ownership, registry distribution, compliance evidence, and support/debug
access. This record defines what must be retained and who owns each source before any artifact-store
implementation work can claim release evidence is supportable.

## Artifact Handoff Matrix

| Artifact class | Provenance source | Retention period | Invalidation/yank handling | Offline bundle expectation | Support/debug access |
|---|---|---|---|---|---|
| SaaS release | Signed build provenance, deployment manifest digest, source revision. | Supported release window plus customer assurance review period. | Records affected deployment ids, replacement release, customer-safe reason, and release-cutline decision. | Marked online-only when excluded from offline bundles. | Retained manifest, digest, rollout evidence, and redacted logs; no provider credentials or tenant data. |
| Self-host/offline bundle | Bundle manifest, signed checksums, SLSA provenance, included artifact digests. | Supported self-host release window. | Records bundle digest, install path, replacement or rollback path, revocation note, and support handoff. | Manifest-complete, digest-pinned, and explicit about unsupported online dependencies. | Bundle manifest, install log schema, known issues, and revocation status without customer secrets. |
| CLI release | CLI package digest, platform build provenance, compatibility evidence. | Supported CLI versions. | Records package version, platform, reason, replacement version, and upgrade-guide note. | Included digest-pinned or marked hosted-only. | Version, platform, checksum, known issues, and troubleshooting facts without local credentials. |
| Package release | Package version, source revision, package digest, provenance ref, publish actor. | Supported package versions. | Records version, replacement range, dependent surfaces, mitigation, and package-cache invalidation. | Carries dependency closure or states unavailable package classes. | Package metadata, deprecation state, vulnerability link, and retained provenance without registry write access. |
| Registry listing | Signed listing descriptor, publisher identity, conformance certificate, artifact digest. | Listing support window plus trust-tier history. | Records listing id, digest, publisher, affected installs, replacement guidance, and trust-tier change. | Includes descriptor, signatures, revocation snapshot, and anti-rollback metadata. | Listing state, digest, certificate, publisher trust, and redacted install evidence without publisher secrets. |
| Generated provider artifact | Material digest, model/toolchain id, eval/conformance refs, signed certification, artifact digest. | Customer-visible generated artifact support window. | Records certification failure, affected capability, replacement candidate, and human approval state. | Includes certification/provenance refs or is excluded as beta limitation. | Certification and conformance summaries, not raw prompts, sensitive materials, or tenant data. |
| Customer assurance packet | Retained manifests, SBOM/notice evidence, release decision, accepted limitation records. | Customer assurance review period and active supported release window. | Records changed claim, removed evidence, replacement wording, notification posture, and owner approval. | Includes evidence manifests and explicit unavailable sections; never implies live provider access. | Approved customer-facing sections and internal redaction notes through support-reviewed path. |

## Handoff Owner Links

| Lane | Owner project | Responsibility | Source of truth |
|---|---|---|---|
| Release engineering | Release Engineering | Release ids, source revisions, signed build provenance, publish/yank decisions, and cutline handoff. | Release train manifest and go/no-go decision |
| Artifact store | Provenance & Retention | Artifact class retention rules, support/debug boundaries, invalidation history, and evidence retention gaps. | Release artifact provenance and retention handoff |
| Package cache | Package Cache | Published package digests, cache invalidation, dependency closure, package yanks, and metadata retention. | Package cache release metadata |
| Registry | Registry & Distribution | Listing descriptors, signed offline bundle metadata, trust-tier history, and install/yank propagation. | Registry listing and offline bundle descriptor |
| Compliance | Compliance Evidence Pack | Customer assurance packet sections, legal/privacy/compliance evidence boundaries, and approved wording. | Customer assurance packet |
| Support | Support Workflow | Support/debug access workflow, redaction rules, escalation path, and customer-safe troubleshooting handoff. | Support handoff and debug access record |

## Known Gap Disposition

| Gap | Disposition | Owner lane | Customer impact |
|---|---|---|---|
| Manual provenance review | Beta limitation | Release engineering | Beta artifacts may require manual provenance review before customer assurance wording is approved. |
| Unretained yank evidence | GA blocker | Artifact store | GA cannot claim supportable release provenance if yank/invalidation evidence is not retained. |
| Automated customer assurance export | Post-GA follow-up | Compliance | Manual assurance packet assembly is acceptable for v1 if evidence sources and retention are recorded. |

## Scope Out And Non-Goals

- Do not implement an artifact store, package cache, registry backend, or production blob retention.
- Do not create live release pipelines, customer assurance export jobs, or support/debug tooling.
- Do not replace SBOM/vulnerability notices, legal/privacy, registry trust-tier, or artifact signing
  contracts.

## Authoritative Dependencies

- [sbom-vulnerability-notice-evidence.md](./sbom-vulnerability-notice-evidence.md) owns SBOM,
  vulnerability, notice, and customer assurance evidence classes.
- [release-notes-upgrade-guide.md](./release-notes-upgrade-guide.md) owns customer-facing release
  wording and upgrade/rollback handoff.
- [ADR-0062](./adr/07-portability-extensibility.md#adr-0062) owns signed/certified registry
  distribution.
- [ADR-0073](./adr/07-portability-extensibility.md#adr-0073) owns artifact-repo integration ports.
- [ADR-0085](./adr/01-architecture-core.md#adr-0085) owns vendored interface and artifact hash
  pinning posture.

## Follow-Up Gate

M1/M2/M3/M4 artifact-store, package-cache, registry, release-pipeline, customer-assurance export,
or support/debug implementation issues must wait until this M0 handoff is accepted. This branch
records the handoff and executable guards; it does not build the storage or support tooling.
