---
type: Reference
title: "Provenance & Retention Scope And Acceptance"
description: "Source issue: HOBO-447."
tags: [hobo, design]
---

# Provenance & Retention Scope And Acceptance

Source issue: HOBO-447.

Executable proof lives in
[`src/draft/exp-proofs/dx/provenance-retention-scope-acceptance`](../../src/draft/exp-proofs/dx/provenance-retention-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-447-provenance-retention`](./proofs/hobo-447-provenance-retention/README.md).

## M0 Acceptance Record

Provenance & Retention exists to define launch-critical product evidence for artifact provenance,
retention classes, audit export, support handoff, yank/rollback explanation, and customer assurance
claims. It is not the artifact store, signing-key system, live registry crawler, legal retention
program, or customer-facing assurance publication workflow.

## User And Business Goal

HoBo needs accepted M0 scope for provenance and retention before downstream design/build work can
depend on artifact evidence. The accepted record must tell customers, internal operators, and
adjacent initiatives which evidence classes exist, who owns them, which retention classes apply,
what M1 must prove, and which assurance claims are backed by named evidence.

## Primary Personas

| Persona | Need |
|---|---|
| Release engineer | Know which build, package, and release artifacts require provenance evidence before publish, yank, or rollback work can depend on them. |
| Security reviewer | Review provenance, signing, audit, and policy-gate expectations without taking signing-key or artifact-store implementation scope. |
| Compliance lead | Understand retention classes, legal/privacy handoffs, and customer-visible assurance claims before compliance evidence is promised. |
| Support operator | Retrieve support-safe artifact, retention, yank, and audit evidence without raw customer data or hidden runtime dependencies. |
| Customer admin | See what provenance and retention assurances HoBo can make, which evidence backs them, and which gaps remain future work. |

## Scope In

- Canonical artifact provenance record classes for source, build, package, publish, install, yank,
  and support-debug evidence.
- Retention class matrix for release artifacts, provenance attestations, audit exports, support
  bundles, and customer assurance summaries.
- Customer-visible assurance claim register that names evidence source, owner, audience, and
  publication boundary for each claim.
- Audit export fixture requirements for retained provenance, retention policy, actor, timestamp,
  artifact identity, and redaction behavior.
- Support/debug handoff requirements for retained artifacts, yanked versions, disputed provenance,
  and customer escalation evidence.
- M1-ready evidence checklist for schema, policy matrix, audit fixture, support handoff, yank
  invalidation, and assurance summary proofs.

## Scope Out And Non-Goals

- Do not build an artifact store, artifact repository, or blob lifecycle implementation.
- Do not implement signing keys, KMS, SLSA signer, certificate issuance, or key rotation.
- Do not implement live registry crawlers, registry mirrors, package scanners, or distributed
  resolvers.
- Do not define a legal retention program, data processing agreement, or jurisdiction-specific
  compliance promise.
- Do not publish customer-facing assurance claims unless each claim names its evidence source.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

Non-goals:

- Replace existing Registry, Release Channels, or Artifact Repo port decisions.
- Define package format semantics beyond provenance and retention fields consumed by later
  contracts.
- Guarantee compliance outcomes before legal/privacy and security reviews accept the evidence
  matrix.
- Create follow-up implementation issues before the M0 scope record is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Provenance and retention are product control-plane evidence records; this issue does not build storage, signing, registry, or resolver services. |
| UX | UX scope is the accepted information architecture for evidence visibility, assurance status, and support handoff, not product screens or flows. |
| Security | Security scope names provenance, audit, redaction, and trust-tier requirements without implementing signing keys, SLSA emitters, or live enforcement. |
| Support | Support can rely on named evidence classes, retention expectations, and redaction boundaries; ticket workflow and SLA promises remain separate support work. |

## Artifact Evidence Classes

| Class | Owner | Retained for |
|---|---|---|
| Source revision | Release engineer | Published artifact lineage and rollback review. |
| Build attestation | Security reviewer | Publish gate and later customer assurance summary. |
| Package manifest | Release engineer | Install, yank, compatibility, and upgrade evidence. |
| Audit export | Compliance lead | Governance-plane review and support escalation. |
| Support-redacted bundle | Support operator | Customer-safe triage without raw customer data. |

## Retention Classes

| Class | Owner | Default retention | Customer visible |
|---|---|---|---:|
| Published artifact | Release Channels | Until superseded plus accepted rollback window. | Yes |
| Provenance attestation | Provenance & Retention | Matches published artifact retention. | Yes |
| Audit export | Audit Explorer | Governance-plane policy controlled. | No |
| Support debug bundle | Support & Debug Tools | Short-lived and redacted by support policy. | No |
| Assurance summary | Capability Review & Approval | Matches claim publication lifetime. | Yes |

## Customer Assurance Claims

| Claim | Audience | Evidence source |
|---|---|---|
| Published artifacts carry source, build, package, and publish provenance fields. | Customer admin | Artifact provenance schema. |
| Retention classes state which artifact and audit evidence is retained for support and assurance. | Compliance lead | Retention policy matrix. |
| Yanked artifacts remain explainable through retained lineage and audit evidence. | Release engineer | Yank invalidation playbook. |
| Support exports redact sensitive data while preserving artifact identity and provenance state. | Support operator | Support debug handoff. |

## Authoritative Dependencies

- [governance-planes.md#plan-46](./governance-planes.md#plan-46) defines governance-plane audit,
  retention, OCSF, and compliance surfaces that consume provenance and retention evidence.
- [platform-engineering.md#plan-25](./platform-engineering.md#plan-25) defines resource pack and
  registry distribution surfaces that require artifact provenance and offline bundle evidence.
- [contracts-policy-flags.md#plan-29](./contracts-policy-flags.md#plan-29) defines policy and
  contract gates for signed, attested, audit-ready artifacts and retention obligations.
- [ADR-0062](./adr/07-portability-extensibility.md#adr-0062) pins registry distribution and trust
  expectations for signed bundles and conformance metadata.
- [ADR-0073](./adr/07-portability-extensibility.md#adr-0073) pins Artifact Repo as a port, keeping
  repository implementation outside this M0 scope.
- [ADR-0046](./adr/02-identity-security.md#adr-0046) pins boundary standards, OTEL, OCSF, and
  identity-aware audit export expectations.
- [ADR-0023](./adr/02-identity-security.md#adr-0023) pins security posture expectations for audit
  retention, SBOM, SLSA provenance, and compliance evidence.

## Owning Initiative Dependencies

| Owner | Consumes from Provenance & Retention | Boundary |
|---|---|---|
| Provenance & Retention | Accepted evidence classes, retention matrix, assurance claim sources, and M1 proof checklist. | This issue defines the scope record; it does not build provenance emitters, storage, or retention jobs. |
| Release Channels | Publish, yank, rollback, and release-note provenance evidence requirements. | Release channel routing, release workflow, and customer notification remain in Release Channels. |
| Compatibility Matrix | Artifact identity, provenance tier, and supported-version retention evidence. | Compatibility calculation and version-resolution semantics remain in Compatibility Matrix. |
| Upgrade Test Suite | Retained artifact and provenance fixtures for upgrade, rollback, and replay expectations. | Upgrade harness execution and test orchestration remain in Upgrade Test Suite. |
| Backup & Restore | Retention classes and audit evidence that distinguish recoverable artifacts from product backups. | Backup storage, restore workflows, and customer data recovery remain in Backup & Restore. |
| Capability Review & Approval | Provenance, SBOM, vulnerability, and assurance evidence for package and capability approval. | Approval workflow, policy authoring, and capability review UI remain outside Provenance M0. |
| Audit Explorer | Audit export fields, redaction rules, actor identity, timestamps, and artifact lineage evidence. | Search, visualization, export UI, and OCSF pipeline implementation remain in Audit Explorer. |
| Support & Debug Tools | Support-safe provenance, retention, yank, and disputed-artifact evidence during escalation. | Ticket routing, incident tooling, and live debug collection remain in Support & Debug Tools. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Artifact provenance schema | Provenance & Retention | Contract test | Artifact evidence has source, build, package, publish, install, yank, and support-debug classes with owners. |
| Retention policy matrix | Compliance | Design record | Retention classes define owner, default retention, customer visibility, and legal/privacy handoff. |
| Audit export fixture | Audit Explorer | Audit fixture | Audit exports preserve actor, artifact identity, timestamp, retention class, and redaction behavior. |
| Support debug handoff | Support & Debug Tools | Support handoff | Support can inspect retained provenance and retention state without raw customer data or runtime control. |
| Yank invalidation playbook | Release Channels | Release playbook | Yank, rollback, and invalidation decisions consume retained lineage without implementing registry workflows. |
| Customer assurance summary | Capability Review & Approval | Customer assurance | Every customer-visible claim maps to a named evidence source and publication boundary. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
