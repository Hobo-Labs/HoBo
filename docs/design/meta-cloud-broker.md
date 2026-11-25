---
type: Reference
title: "Meta-cloud Broker"
description: "Source issue: HOBO-521."
tags: [hobo, design]
---

# Meta-cloud Broker

Source issue: HOBO-521.

Runtime architecture (what the broker wraps, enforcement order, event
families, `@hobo/broker`): [`hobo-broker.md`](./hobo-broker.md).

Executable proofs:

- [`meta-cloud-broker-scope-contract`](../../src/draft/exp-proofs/api/meta-cloud-broker-scope-contract/README.md)
- [`meta-cloud-broker-artifact-contract`](../../src/draft/technical-proofs/meta-cloud-broker-artifact-contract/README.md)
- [`yard-receipt-consumption-contract`](../../src/draft/technical-proofs/yard-receipt-consumption-contract/README.md)
- [`meta-cloud-broker-resolution-contract`](../../src/draft/technical-proofs/meta-cloud-broker-resolution-contract/README.md)
- [`meta-cloud-broker-rejection-matrix-contract`](../../src/draft/exp-proofs/api/meta-cloud-broker-rejection-matrix-contract/README.md)
- [`broker-receipt-integrity-contract`](../../src/draft/technical-proofs/broker-receipt-integrity-contract/README.md)
- [`broker-environment-publication-contract`](../../src/draft/technical-proofs/broker-environment-publication-contract/README.md)
- [`broker-admin-controls-contract`](../../src/draft/technical-proofs/broker-admin-controls-contract/README.md)

Branch evidence:

- [`HOBO-521 proof record`](./proofs/hobo-521-meta-cloud-broker/README.md)
- [`HOBO-522 proof record`](./proofs/hobo-522-meta-cloud-broker-artifacts/README.md)
- [`HOBO-523 proof record`](./proofs/hobo-523-yard-receipt-consumption/README.md)
- [`HOBO-525 proof record`](./proofs/hobo-525-meta-cloud-broker-resolution/README.md)
- [`HOBO-528 proof record`](./proofs/hobo-528-meta-cloud-broker-rejection-matrix/README.md)
- [`HOBO-529 proof record`](./proofs/hobo-529-broker-receipt-integrity/README.md)
- [`HOBO-526 proof record`](./proofs/hobo-526-broker-environment-publication/README.md)
- [`HOBO-527 proof record`](./proofs/hobo-527-broker-admin-controls/README.md)

This M0 record defines the accepted productization scope for the Meta-cloud Broker. It does not
build broker runtime code, Yard planner behavior, provider adapters, admin UI, Gatekeeper policy
changes, token broker changes, Contract IR changes, or provider Capability Manifest changes.

Brainstorming spec: [`2026-06-29-meta-cloud-broker-design.md`](../superpowers/specs/2026-06-29-meta-cloud-broker-design.md).
The HOBO-521 issue body, that spec, and this M0 record are the reviewable source of truth.

## M0 Acceptance Record

Meta-cloud Broker is accepted for M1 only when this record and the executable draft proof agree on:

- the user/business goal and primary personas;
- scope in, scope out, and non-goals;
- broker, Yard, admin, and Gatekeeper authority boundaries;
- the core artifact vocabulary and minimum M1 proof expectations;
- service, UX, security, and support ownership boundaries;
- M1 proof evidence; and
- the follow-up issue gate.

M1/M2/M3/M4 follow-up issues must wait until the M0 scope record is accepted.

## User And Business Goal

HoBo needs a distinct hosted broker authority before downstream broker work can claim safe
meta-cloud resolution. The business goal is to validate application Contract Manifests against
approved Broker Environments and emit Resolution Receipts or Resolution Rejections that Yard can
consume without silently re-running hosted broker authority locally.

## Primary Personas

| Persona | Need |
|---|---|
| Broker admin | Approves Broker Environments and mapping state without becoming the broker authority. |
| Platform engineer | Publishes provider/catalog/mapping evidence that the broker can validate deterministically later. |
| App developer | Receives clear receipt or rejection evidence for a Contract Manifest without guessing placement rules. |
| Support operator | Explains failed or stale broker resolution using customer-safe receipt and rejection evidence. |
| Security reviewer | Verifies authority, tamper, replay, and policy boundaries before public broker claims ship. |

## Scope In

- Name the user/business goal and primary broker-admin, platform-engineer, app-developer,
  support-operator, and security-reviewer personas.
- Record broker-vs-Yard-vs-admin-vs-Gatekeeper authority boundaries.
- Define the M1 artifact vocabulary: Contract Manifest, Broker Environment, Mapping Contract,
  Broker Catalog Snapshot, Resolution Receipt, and Resolution Rejection.
- Map owning initiative and project dependencies without taking their implementation scope.
- List M1 evidence required before artifact schema, receipt consumption, deterministic resolution,
  admin controls, or adversarial hardening work can fan out.
- Record the follow-up gate that blocks M1/M2/M3/M4 broker work until this M0 scope is accepted.

## Scope Out And Non-Goals

- Do not implement broker runtime code, resolution algorithms, hosted service persistence, signing,
  or live broker execution.
- Do not implement Yard planner, Matching, ResourcePlan, DeploymentPlan, provider adapter, or IaC
  behavior changes.
- Do not implement admin UI, settings pages, approval workflows, or a live operator console.
- Do not replace Gatekeeper, policy engine, token broker, Contract IR, or provider Capability
  Manifest.
- Do not make public or release-facing broker claims without named proof mode and source evidence.
- Do not create or start downstream M1-M4 broker work before this M0 record and executable proof are
  accepted.

## Authority Boundaries

| Boundary | Owner | M0 decision |
|---|---|---|
| Meta-cloud Broker | Meta-cloud Broker | Validates Contract Manifests against approved Broker Environments and emits signed Resolution Receipts or structured Resolution Rejections. |
| Yard control plane | Control Plane: Planner, Matching & Orchestrator | Consumes Resolution Receipts as broker evidence and executes Yard-local planning without silently re-resolving hosted broker authority. |
| UX admin controls | Admin Console | Proposes and approves Broker Environment inputs; cannot mutate an issued receipt after resolution. |
| Gatekeeper | Contracts, Policy & Governance | May block, waive, or require policy obligations, but does not rewrite broker mapping outcomes. |

Yard, admin controls, and Gatekeeper cannot overwrite a broker decision in place. A superseding
decision requires a new Resolution Receipt, a new Resolution Rejection, or an explicit policy
decision with its own evidence.

## Core Artifact Vocabulary

| Artifact | Owner | Minimum M1 proof expectation |
|---|---|---|
| Contract Manifest | App developer / SDK authoring | Schema fixture names requested capabilities, constraints, and declared application contract facts. |
| Broker Environment | Broker admin | Approved environment snapshot fixture lists allowed providers, catalogs, policies, and version pins. |
| Mapping Contract | Platform engineering | Mapping fixture proves provider/catalog choices are constrained inputs, not unilateral selection authority. |
| Broker Catalog Snapshot | Registry / provider catalog | Snapshot fixture pins provider Capability Manifest, conformance, trust tier, and stale-state behavior. |
| Resolution Receipt | Meta-cloud Broker | Receipt fixture names manifest digest, environment digest, decision, signature envelope, and Yard handoff facts. |
| Resolution Rejection | Meta-cloud Broker | Rejection fixture names deterministic reason codes for stale, incompatible, ambiguous, or unsupported mappings. |

## Service, UX, Security, And Support Boundaries

| Boundary | Owner | M0 decision |
|---|---|---|
| Service | Meta-cloud Broker | Owns authority vocabulary, artifact set, evidence list, and follow-up gate; runtime implementation waits for later issues. |
| UX | Admin Console | May later expose environment proposal and approval controls; UI work is out of this M0 issue. |
| Security | Contracts, Policy & Governance | Requires proof that Gatekeeper policy can block or require obligations without rewriting broker receipts. |
| Support | Support Workflow | Receives customer-safe receipt/rejection evidence and escalation ownership without hidden resolution changes. |

## Owning Initiative Dependencies

| Initiative | Dependency |
|---|---|
| Meta-cloud Broker | Owns M0 authority vocabulary, artifact set, evidence list, and follow-up gate. |
| Control Plane: Planner, Matching & Orchestrator | Owns later Yard receipt consumption and no-re-resolve proof; planner implementation remains there. |
| Providers, IaC & Build Adapters | Owns provider Capability Manifests, catalog entries, and mapping publications consumed by broker proofs. |
| Contracts, Policy & Governance | Owns Gatekeeper decisions, policy obligations, and contract compatibility without rewriting receipts. |
| Admin Console | Owns later UX controls for environment proposals and approvals, not this M0 scope record. |
| Support Workflow | Consumes receipt/rejection evidence for customer-safe debugging and escalation. |
| V1 Release Program & Cutline | Uses proof mode and source evidence before public broker claims or GA handoff language. |

## Evidence Required For M1

| Evidence | Mode | Proves |
|---|---|---|
| Artifact schema contract | Schema test | Contract Manifest, Broker Environment, Mapping Contract, catalog snapshot, receipt, and rejection schemas are pinned. |
| Authority boundary fixture | Contract test | Broker, Yard, admin controls, and Gatekeeper cannot silently overwrite each other. |
| Receipt consumption fixture | Integration fixture | Yard consumes Resolution Receipts without re-running hosted broker resolution; HOBO-523 proves this with `yard-receipt-consumption-contract`. |
| Catalog snapshot fixture | Deterministic fixture | Provider/catalog mapping inputs are versioned and stale states are visible; HOBO-526 proves approved provider/catalog/mapping publications become immutable Broker Environment snapshots. |
| Rejection taxonomy fixture | Negative test | Stale, incompatible, ambiguous, and unsupported mappings fail with structured Resolution Rejections. |
| Scope-boundary register | Policy fixture | Runtime, planner, provider, admin UI, Gatekeeper, and public-claim work route to follow-up owners. |

## M2 Deterministic Resolution Evidence

HOBO-525 proves the first working broker-resolution slice with
`meta-cloud-broker-resolution-contract`: the same Contract Manifest and Broker Environment snapshot
produce identical receipt or rejection output, snapshot identity is an explicit replay input,
ambiguous/incompatible/unavailable mappings fail with structured Resolution Rejections, provider
defaults cannot act as implicit broker decisions, and missing mappings never fall back to Yard-local
Matching.

## M3 Adversarial Rejection Matrix Evidence

HOBO-528 hardens the broker rejection boundary with
`meta-cloud-broker-rejection-matrix-contract`: stale catalog, incompatible mapping, ambiguous
mapping, missing mapping, and unsupported capability fixtures each emit signed structured
Resolution Rejections; no case emits a partial receipt, optimistic Yard plan, or unsigned evidence;
support/debug evidence keeps replay digests and evidence IDs while excluding secrets and raw
customer payloads; and ambiguous best-effort selection, stale catalog optimism, provider-default
fallback, and hidden Yard-local planning all fail closed.

## M3 Receipt Integrity Evidence

HOBO-529 proves Resolution Receipt integrity hardening with `broker-receipt-integrity-contract`.
The proof accepts valid Ed25519-signed fixture receipts and rejects tampered, replayed, downgraded,
expired, tenant-mismatched, environment-mismatched, broker-snapshot-mismatched, and
manifest-mismatched receipts with customer-safe refusal evidence. It keeps Gatekeeper as a
downstream apply-time policy boundary rather than a broker receipt-integrity shortcut.

## M4 Hosted Broker GA Handoff Evidence

HOBO-530 records the hosted broker GA handoff evidence with
[`hosted-broker-ga-handoff-evidence-contract`](../../src/draft/exp-proofs/cx/hosted-broker-ga-handoff-evidence-contract/README.md).
The handoff checklist names the Meta-cloud Broker, Dogfood Yard, Release Notes, Launch Support, and
provider/catalog owner lanes before any GA language can be used.

The M4 record requires:

- an operational owner checklist with source evidence;
- Dogfood Yard deploy-readiness links for Resolution Receipts and Resolution Rejections;
- compatibility windows for receipt schema v1, Broker Environment snapshots, and catalog snapshot
  versions;
- rollback/restore limits that preserve receipt replay without mutating issued receipts; and
- broker-specific release-note and support/debug entries.

This is handoff evidence, not live hosted broker GA proof. Local fixtures, docs, manually edited
receipts, or unresolved Dogfood/cutline evidence cannot publish a hosted broker GA claim.

## Authoritative Dependencies

- [Architecture](./architecture.md) supplies Yard, Registry, Identity, Provider, and Capability
  Manifest context.
- [Control Plane](./control-plane.md) supplies planner, matching, deployment plan, and provider
  capability feedback context.
- [Platform Engineering](./platform-engineering.md) supplies Resource Definition, provider-owned
  defaults, pre-approved catalog, and offline bundle context.
- [Contracts & Policy](./contracts-policy-flags.md) supplies Gatekeeper, contract, policy, waiver,
  and obligation boundaries.
- [Glossary](./glossary.md) supplies the shared vocabulary introduced by this M0 record.

## Follow-Up Gate

Do not create or start M1/M2/M3/M4 Meta-cloud Broker follow-up work until reviewers accept this M0
scope record and its executable proof. Adjacent decisions route to the owning initiatives above:
Yard receipt consumption to Control Plane, provider/catalog publication to Providers/IaC, policy and
waiver behavior to Contracts & Policy, environment proposal UX to Admin Console, and customer-safe
debugging to Support Workflow.

## M2 Admin-Control Proof

HOBO-527 proves the Admin Console to Meta-cloud Broker admin-control boundary with
`broker-admin-controls-contract`: admin proposal, approval, and revocation commands create auditable
Broker Environment input events and snapshots, reject malformed or cross-environment approvals, and
do not mutate issued Resolution Receipts, execute hosted broker runtime behavior, build admin UI
navigation, change Yard planner behavior, or rewrite Gatekeeper policy outcomes.
