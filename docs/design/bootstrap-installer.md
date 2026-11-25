---
type: Reference
title: "Bootstrap Installer Scope And Acceptance"
description: "Source issue: HOBO-428."
tags: [hobo, design]
---

# Bootstrap Installer Scope And Acceptance

Source issue: HOBO-428.

Executable proof lives in
[`src/draft/exp-proofs/dx/bootstrap-installer-scope-contract`](../../src/draft/exp-proofs/dx/bootstrap-installer-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-428-bootstrap-installer`](./proofs/hobo-428-bootstrap-installer/README.md).
Launch smoke matrix proof lives in
[`src/draft/exp-proofs/dx/bootstrap-launch-smoke-matrix-contract`](../../src/draft/exp-proofs/dx/bootstrap-launch-smoke-matrix-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-501-bootstrap-launch-smoke-matrix`](./proofs/hobo-501-bootstrap-launch-smoke-matrix/README.md).

## M0 Acceptance Record

Bootstrap Installer exists to define the accepted productization boundary for SaaS bootstrap,
self-host bootstrap, and local/dev bootstrap paths before follow-up design or implementation
work fans out. The record defines the personas, setup modes, evidence, and owner boundaries needed
before HoBo can claim installability.

## User And Business Goal

HoBo needs accepted M0 scope for Bootstrap Installer so app developers, platform engineers, DevOps
operators, support, and security reviewers know which setup paths are supported, which evidence must
exist next, and which adjacent teams own auth, Yard dogfood, CLI/DX, support, and release decisions.
The accepted record must support launch planning without building a production installer in this
issue.

## Primary Personas

| Persona | Need |
|---|---|
| App developer | Install or start HoBo locally, create a first project, and understand supported bootstrap states without learning platform internals. |
| Platform engineer | Know which SaaS, self-host, and local/dev setup paths must be proven before implementation starts. |
| DevOps operator | Plan self-host bootstrap, seed handoff, recovery, and upgrade hooks without relying on undocumented manual setup. |
| Support engineer | Route failed installs, bootstrap recovery, unsupported environments, and cleanup requests with explicit evidence. |
| Security/compliance reviewer | Review seed credentials, secret handling, offline mode, audit evidence, and unsupported trust assumptions before customer bootstrap claims. |

## Scope In

- Accepted install-path matrix for SaaS bootstrap, self-host bootstrap, and local/dev bootstrap modes.
- Required setup stages for preflight, seed/auth handoff, first project, first deploy smoke shape,
  recovery, and cleanup evidence.
- Explicit boundary between Bootstrap Installer scope and Dogfood Yard, Identity, CLI/DX, Support
  Workflow, and release cutline ownership.
- M1-ready evidence checklist for bootstrap path fixtures, seed credential handling, unsupported
  environment routing, and support troubleshooting handoff.
- Follow-up gate that blocks M1-M4 implementation issues until M0 scope and acceptance are recorded.

## Scope Out And Non-Goals

- Do not build production installer scripts, package manager publishing, native installer binaries,
  or an update service.
- Do not provision live cloud resources, build the hosted control plane, execute first deploys, or
  implement Yard bootstrap internals.
- Do not create accounts, implement an identity provider, collect billing signup, provision tenants,
  or build production auth flows.
- Do not collect real secrets, persist credentials, mint seed tokens, or scan customer environments.
- Do not implement uninstall cleanup, migration, backup/restore, or upgrade execution.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Bootstrap Installer M0 defines accepted setup modes, stages, evidence, and ownership boundaries; it does not build installer services, provisioning, deployment, or runtime components. |
| UX | UX scope is the future setup journey and troubleshooting contract for SaaS, self-host, and local/dev paths, not a rendered installer UI or onboarding wizard. |
| Security | Security scope records seed credential, secret handling, offline, and audit expectations without minting real credentials, storing secrets, or scanning live customer environments. |
| Support | Support receives setup-stage diagnostics, unsupported-state routing, recovery evidence, and cleanup handoff rules; support queues, SLAs, and remediation execution remain separate. |

## Install Path Matrix

| Path | Primary user | M1 evidence shape | Unsupported states |
|---|---|---|---|
| SaaS bootstrap | App developer | Account/workspace preflight, first project setup, first deploy smoke shape, recovery, and support handoff. | Production auth implementation, billing signup, tenant provisioning, and live deploy execution. |
| Self-host bootstrap | DevOps operator | Seed Yard prerequisites, provenance import, Identity handoff, air-gap constraints, recovery, and cleanup evidence. | Real seed-token minting, control-plane installation, live cloud provisioning, and upgrade runner implementation. |
| Local/dev bootstrap | App developer | Runtime prerequisite checks, fixture boundaries, first project shape, mock deploy shape, and unsupported OS/tool routing. | Production local runtime parity claim, remote resource provisioning, secret collection, and customer data scans. |

## Seed Auth And Secret Handling

M1 proof must name the seed credential source, allowed scope, TTL expectation, audit event shape,
Identity handoff boundary, token-broker dependency, offline mode behavior, and secret-handling
posture. This M0 record does not mint credentials or store secrets.

## Failure Recovery And Cleanup Boundaries

Bootstrap evidence must distinguish retryable preflight failures, blocked unsupported environments,
partial setup states, recovery checkpoints, support handoff, and cleanup evidence. Cleanup is a
future contract shape only; this issue does not remove files, destroy infrastructure, or roll back
live services.

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines developer setup,
  CLI, dashboard, and status experience that Bootstrap Installer must prepare without implementing.
- [walkthrough.md](./walkthrough.md) defines role journeys where SaaS, self-host, and local/dev
  bootstrap paths surface to app developers and operators.
- [dogfood-yard.md](./dogfood-yard.md) defines hosted and self-hosted Yard acceptance scenarios
  consumed as bootstrap smoke evidence.
- [ADR-0092](./adr/01-architecture-core.md#adr-0092) pins self-host bootstrap as disposable seed
  Yard, provenance import, Identity handover, and recovery table.
- [ADR-0036](./adr/07-portability-extensibility.md#adr-0036) defines air-gapped and sovereign Yard
  constraints that bootstrap evidence must not overclaim.
- [ADR-0008](./adr/02-identity-security.md#adr-0008) defines keyless agent identity and token broker
  boundaries consumed by seed/auth handoff evidence.

## Owning Initiative Dependencies

| Owner | Consumes from Bootstrap Installer | Boundary |
|---|---|---|
| Bootstrap Installer | Accepted install paths, setup stages, evidence checklist, unsupported-state routing, and follow-up gate. | This issue defines scope and acceptance; it does not build installers or provisioning paths. |
| Dogfood Yard | Bootstrap path expectations as hosted/self-hosted dogfood scenario input. | Dogfood acceptance proves Yard scenarios, not installer implementation. |
| Identity & Auth | Future seed credential, auth handoff, and token broker contracts. | Identity provider, seed-token minting, account creation, and tenant auth stay in Identity & Auth. |
| CLI/MCP & Developer Experience | Future command surface, setup output, and local developer entry points. | CLI parser, native packages, onboarding UI, MCP tools, and live deploy commands stay out of this M0 record. |
| Support Workflow | Setup-stage diagnostics, unsupported-state classifications, and troubleshooting handoff evidence. | Ticket queues, support SLAs, escalation, and remediation execution stay in Support Workflow. |
| V1 Release Program & Cutline | Accepted M0 record for deciding when M1-M4 follow-up issues may be created. | Release go/no-go, launch claims, and downstream issue creation remain release-program scope. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Install-path matrix | Platform engineer | This document's install-path matrix | Design record | SaaS, self-host, and local/dev setup modes each name user, stages, evidence, and unsupported states. |
| Bootstrap seed and auth handoff record | Security/compliance reviewer | Seed/auth and secret-handling section | Security review | Seed credential, Identity handoff, token broker, and secret-handling assumptions are explicit before implementation. |
| First project and first deploy smoke shape | App developer | Evidence checklist | Smoke matrix | First project and first deploy smoke checks are shaped without claiming real deploy execution in M0. |
| Failure recovery and uninstall boundary | DevOps operator | Failure/recovery boundary section | Reference fixture | Failed install, retry, recovery, and cleanup states have named evidence and remain separate from implementation. |
| Support troubleshooting handoff | Support engineer | Owning-initiative boundary table | Support handoff | Support can route bootstrap failures with setup-stage diagnostics and unsupported-state labels. |
| Security secret-handling review | Security/compliance reviewer | Security boundary record | Security review | M1 proof must document no secret persistence, no live environment scan, and no unaudited seed credential path. |

## HOBO-501 Launch Smoke Matrix Proof

HOBO-501 accepts the launch smoke matrix as executable M1 evidence for this design record. The
matrix binds each SaaS, self-host, and local/dev bootstrap path to preflight, auth seed, first
project, first deploy, failure recovery, and cleanup/uninstall boundary stages. Each stage names
fixture evidence, mocked boundary ownership, unsupported states, and result ids that feed release
notes, troubleshooting, and support handoff inputs.

The proof remains a contract-only surface. It rejects production installer scripts, live cloud
provisioning, production auth, real deploy execution, secret persistence, customer environment
scans, and uninstall cleanup implementation so launch smoke evidence cannot silently expand into
production installer runtime.

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
