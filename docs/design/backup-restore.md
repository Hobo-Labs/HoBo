---
type: Reference
title: "Backup & Restore Scope And Acceptance"
description: "Source issue: HOBO-429."
tags: [hobo, design]
---

# Backup & Restore Scope And Acceptance

Source issue: HOBO-429.

Executable proof lives in
[`src/draft/exp-proofs/dx/backup-restore-scope-contract`](../../src/draft/exp-proofs/dx/backup-restore-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-429-backup-restore`](./proofs/hobo-429-backup-restore/README.md).
M1 launch-drill proof lives in
[`src/draft/exp-proofs/dx/backup-restore-launch-drill-contract`](../../src/draft/exp-proofs/dx/backup-restore-launch-drill-contract/README.md)
with branch evidence in
[`proofs/hobo-498-backup-restore-launch-drill`](./proofs/hobo-498-backup-restore-launch-drill/README.md).

## M0 Acceptance Record

Backup & Restore exists to define launch-critical recovery scope before later design or
implementation work depends on it. The record names backup sources, restore paths, RPO/RTO evidence,
failure modes, and owner boundaries. It is not a backup storage service, restore runner, scheduler,
support workflow, compliance approval, or live customer recovery program.

## User And Business Goal

HoBo needs accepted M0 scope for Backup & Restore so platform engineers, SRE operators, support,
security/compliance reviewers, and customer admins know what recovery evidence must exist before M1
design and contract proof starts. The accepted record must support launch planning without claiming
production restore readiness.

## Primary Personas

| Persona | Need |
|---|---|
| Platform engineer | Know which platform data sets and restore paths later design work must prove before launch readiness claims depend on them. |
| SRE operator | Run or review deterministic backup/restore drills with explicit RPO/RTO, failure, rollback, and escalation evidence. |
| Support engineer | Route failed backup or restore cases with customer-safe state, owner, limitation, and next-action evidence. |
| Security/compliance reviewer | Review retention, encryption, access, audit, and customer-assurance boundaries without approving a production recovery program in M0. |
| Customer admin | Understand what HoBo can claim about recovery readiness, which evidence backs it, and which states remain unsupported. |

## Scope In

- Accepted backup-source inventory covering control-plane metadata, deployment state,
  artifact/provenance records, audit exports, configuration, and support bundles.
- Restore-path matrix for SaaS, self-host, and local/dev launch contexts with named owners, restore
  target, unsupported states, and evidence source.
- RPO/RTO drill evidence contract naming fixture inputs, expected outputs, measurement window,
  pass/fail rule, and rollback or escalation handoff.
- Failure-mode and recovery register for missing backup, stale backup, corrupted backup, partial
  restore, permission denial, and unsupported customer-data restore.
- Explicit boundary between Backup & Restore, Provenance & Retention, Upgrade & Migration Engine,
  Support Workflow, Compliance Evidence Pack, and release cutline ownership.
- Follow-up gate that blocks M1-M4 implementation issues until M0 scope and acceptance are recorded.

## Scope Out And Non-Goals

- Do not build production backup storage, cloud storage backends, snapshot schedulers,
  cross-region replication, or backup service runtime.
- Do not execute live customer restores, customer data recovery, destructive restore paths, or
  production restore services.
- Do not implement an upgrade rollback runner, migration engine, compatibility matrix, or
  release-channel automation.
- Do not provide legal, privacy, compliance, DPA, or customer-assurance approval beyond naming
  required evidence and owners.
- Do not build ticketing systems, incident automation, support queues, or SLA workflow
  implementation.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

Non-goals:

- Replace provenance retention, upgrade dry-run, launch support, or legal/privacy readiness
  records.
- Build production restore tooling, backup scheduling, object storage integration, or regional
  failover.
- Claim production restore readiness before deterministic drill fixtures prove the launch path.
- Use live customer data, destructive recovery operations, or unsupported production dependencies in
  M0.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Backup & Restore M0 defines accepted data sets, restore paths, drill evidence, failure modes, and owner boundaries; it does not build backup storage or restore services. |
| UX | UX scope is the future status, limitation, and recovery evidence contract a customer or operator can read, not a restore UI or dashboard implementation. |
| Security | Security scope names retention, encryption, access, audit, and customer-assurance evidence without approving compliance posture or touching live customer data. |
| Support | Support receives recovery-state routing, failure classification, limitation, owner, and escalation evidence; support queues and remediation execution remain separate. |

## Backup Source Inventory

| Source | Owner | Restore target | Customer visible |
|---|---|---|---:|
| Control-plane metadata | Platform engineer | Yard control-plane state | Yes |
| Deployment state | SRE operator | Deployment and resource state projections | Yes |
| Artifact provenance | Security/compliance reviewer | Retained artifact lineage and provenance records | Yes |
| Audit export | Security/compliance reviewer | Governance and support audit evidence | No |
| Support bundle | Support engineer | Redacted support/debug context | No |

## Restore Path Matrix

| Path | Primary user | Target | Unsupported states |
|---|---|---|---|
| SaaS control-plane restore | SRE operator | Hosted control-plane metadata and projections. | Tenant data recovery without accepted backup drill evidence. |
| Self-host Yard restore | Platform engineer | Self-host Yard state from operator-owned backup evidence. | Managed restore into an unknown customer environment. |
| Local/dev fixture restore | App developer | Fixture-only local/dev state for documentation and tests. | Production parity claim or destructive local recovery. |

## Failure Mode And Recovery Register

| Failure mode | Required routing |
|---|---|
| Missing backup | Block restore claim, route to support and release limitation. |
| Stale backup | Report RPO breach and require explicit operator/customer decision. |
| Corrupted backup | Block automated restore and require alternate backup or manual escalation. |
| Partial restore | Keep parent operation unsafe until rollback, cleanup, or operator handoff is recorded. |
| Permission denial | Fail closed and preserve audit evidence for security/compliance review. |
| Unsupported customer-data restore | Mark unsupported and route to known limitation, not best-effort recovery. |

## Authoritative Dependencies

- [reliability-observability-cost.md#plan-05](./reliability-observability-cost.md#plan-05) defines
  reliability, HA, SLO, and operational-readiness language consumed by backup/restore evidence.
- [data-plane.md#plan-11](./data-plane.md#plan-11) defines event-log, replay, and projection
  behavior that restore evidence must not overclaim.
- [provenance-retention.md](./provenance-retention.md) defines artifact retention and audit
  evidence that must be distinguished from product backups.
- [bootstrap-installer.md](./bootstrap-installer.md) defines SaaS, self-host, and local/dev setup
  modes whose recovery paths need later drill evidence.
- [launch-support-escalation.md](./launch-support-escalation.md) defines support escalation and
  communication surfaces that consume failed backup/restore handoffs.
- [ADR-0082](./adr/02-identity-security.md#adr-0082) pins Golden Suites as launch evidence gates;
  backup/restore drills feed that readiness lane.

## Owning Initiative Dependencies

| Owner | Consumes from Backup & Restore | Boundary |
|---|---|---|
| Backup & Restore | Accepted backup-source inventory, restore-path matrix, RPO/RTO drill evidence, failure register, and follow-up gate. | This issue defines scope and acceptance; it does not build backup storage or run restores. |
| Provenance & Retention | Retained artifact and audit evidence used to distinguish recoverable artifacts from product backup scope. | Retention classes, provenance attestations, and audit exports stay in Provenance & Retention. |
| Upgrade & Migration Engine | Restore/rollback evidence for upgrade dry-run and migration compatibility planning. | Upgrade rollback, migration planning, and compatibility calculations stay in Upgrade & Migration Engine. |
| Support Workflow | Failure-mode routing, recovery state, and escalation evidence for support handoff. | Ticket queues, SLA commitments, public incident communication, and remediation execution stay in support initiatives. |
| Compliance Evidence Pack | Backup/restore evidence, limitations, and audit posture for customer assurance readiness. | Legal approval, DPA terms, compliance claims, and customer assurance publication stay outside this M0 record. |
| V1 Release Program & Cutline | Accepted M0 record for deciding when M1-M4 backup/restore proof issues may be created. | Release go/no-go, launch claims, and downstream issue creation remain release-program scope. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Backup-source inventory | Platform engineer | This document's backup-source inventory | Design record | Each accepted backup source names owner, restore target, customer visibility, and excluded implementation scope. |
| Restore-path matrix | SRE operator | Restore-path matrix | Recovery matrix | SaaS, self-host, and local/dev restore paths name target, evidence source, unsupported states, and owner. |
| RPO/RTO drill fixture | SRE operator | Evidence checklist | Drill fixture | M1 drill can measure RPO/RTO with deterministic fixture input, output, and pass/fail rules. |
| Failure-mode recovery register | Support engineer | Failure-mode register | Contract test | Missing, stale, corrupt, partial, denied, and unsupported recovery states route safely. |
| Support/compliance handoff | Security/compliance reviewer | Owning-initiative boundary table | Support handoff | Support and compliance can consume backup/restore limitations without approving final claims. |
| Rollback/cleanup boundary | Platform engineer | Scope-out and non-goals | Security review | Rollback, migration, cleanup, scheduler, storage, and live restore work stay in owning follow-up issues. |

## M1 Launch Drill Contract

HOBO-498 records the first deterministic launch-drill contract for Backup & Restore. The contract
requires each drill to name:

- accepted data sets: control-plane metadata, deployment state projections, artifact provenance,
  audit export, and support bundle;
- one restore path each for SaaS, self-host, and local/dev contexts;
- RPO/RTO targets, evidence-output fields, fixture source, unsupported states, and rollback path for
  each restore context;
- required routing for missing, stale, corrupted, partial, permission-denied, and unsupported
  customer-data restore failures; and
- owner handoffs for support, compliance/customer assurance, installation/bootstrap, and release
  notes gaps.

The launch-drill contract is not a production restore service. A production restore readiness claim
is invalid until successful deterministic drill evidence exists, and the drill cannot use live
customer data or destructive customer recovery.

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
