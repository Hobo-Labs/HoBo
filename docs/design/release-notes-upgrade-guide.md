---
type: Reference
title: "V1 Release Notes and Upgrade Guide"
description: "Release notes and upgrade guidance are the launch handoff between release engineering, docs,"
tags: [hobo, design]
---

# V1 Release Notes and Upgrade Guide

> M0 outline contract for HOBO-407. This record defines the release-note and upgrade-guide table
> of contents, required evidence inputs, and scope guards. It is not final customer-facing release
> copy.

## Purpose

Release notes and upgrade guidance are the launch handoff between release engineering, docs,
bootstrap, compatibility, and support. V1 needs the outline before release-candidate evidence exists
so each owner can feed the correct source of truth without inventing unsupported claims.

## Outline

| Section | Required input | Owner domain | Customer-facing only when |
|---|---|---|---|
| Release summary | Cutline, go/no-go decision | Release | Release-candidate decision is accepted |
| Supported install paths | Bootstrap smoke matrix | Bootstrap | SaaS, self-host, or local path has smoke evidence |
| Upgrade paths | Upgrade dry-run, artifact provenance | Release | Source/target path has compatibility evidence |
| Compatibility matrix | Browser/device/platform matrix and e2e thresholds | Compatibility | Each supported surface has test or smoke evidence |
| Known limitations | [Known-limitation register](./known-limitations-register.md), blocker taxonomy, support route, and launch-message disposition | Docs/support/launch | Limitation owner, customer-visible wording, workaround, follow-up, and beta/GA review checkpoint are approved |
| Rollback guidance | Backup/restore drill and upgrade dry-run | Release/support | Drill evidence is distinguished from production recovery claims |
| Migration notes | Migration compatibility and tenant-data inventory | Docs/compatibility | Data/config/artifact changes have source evidence |
| Support contacts | Support SLA and incident communications | Support | Channel, severity route, and escalation coverage are recorded |

## Input Map

| Source project | Feeds | Evidence |
|---|---|---|
| Release Engineering | Summary, upgrade paths, rollback guidance | Release-candidate decision, artifact provenance, rollback decision |
| V1 Docs | Summary, limitations, migration notes | Outline owner, customer-facing copy owner, [known-limitation register](./known-limitations-register.md) |
| Bootstrap Installer | Install paths, support contacts | Smoke matrix, troubleshooting handoff |
| Compatibility Matrix | Compatibility matrix, migration notes | Supported surfaces, unsupported environments, test evidence |
| Support Workflow | Limitations, rollback guidance, support contacts | Support channel, severity route, escalation coverage |

## Hosted Broker Entries

HOBO-530 adds broker-specific release-note inputs. Release notes may reference the hosted broker only
when they cite accepted handoff evidence for:

- receipt schema v1 compatibility and Broker Environment snapshot versioning;
- catalog snapshot freshness and known stale-catalog limitations;
- rollback/restore wording that describes receipt replay as audit/planning evidence, not mutable
  receipt repair; and
- support/debug routing for Resolution Receipt and Resolution Rejection evidence.

Final release copy must keep live hosted broker GA claims out of customer-facing text until Dogfood
Yard and release cutline evidence are accepted by their owners.

## Missing Evidence Policy

Missing evidence is classified before any release claim is written:

- Required launch claim without accepted evidence: file a release-blocker candidate.
- Non-blocking gap: file an explicit follow-up or list it as a launch limitation.
- Accepted substitute evidence: allowed only when the source owner and limitation text are recorded.

## Scope Guards

- Do not write final release notes before release-candidate evidence exists.
- Do not invent compatibility guarantees without supporting tests.
- Do not resolve release blockers in this issue; the outline only routes missing evidence.

## M1 Dogfood/Alpha Evidence Gate

HOBO-459 adds the M1 dogfood/alpha gate for this release-note surface. The gate records the
accepted proof needed before dogfood/alpha wording can appear in the release-note outline, while
still blocking final release notes until release-candidate evidence exists.

The M1 gate requires:

- dogfood/alpha evidence mapped to owning launch projects, release-note sections, and v1 cutline
  blocker categories;
- blockers and accepted risks recorded as explicit gate fields;
- cross-project dependencies reflected through the release cutline;
- follow-up execution issues only where evidence is missing; and
- a parent HoBo v1 Release Readiness status update whenever this gate changes launch risk.

The accepted gate may record dogfood-only copy risk. That risk must not be promoted into production
upgrade, compatibility, or support claims until release-candidate evidence replaces it.

## M3 Release Candidate Evidence

Source issue: HOBO-473.

Executable proof lives in
[`../../src/draft/exp-proofs/cx/v1-release-notes-upgrade-guide-release-candidate-evidence-contract`](../../src/draft/exp-proofs/cx/v1-release-notes-upgrade-guide-release-candidate-evidence-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-473-release-notes-release-candidate`](./proofs/hobo-473-release-notes-release-candidate/index.md).

The M3 gate records release-note evidence for:

- M0 outline baseline owned by V1 Release Notes & Upgrade Guide;
- release-candidate cutline evidence owned by V1 Release Program & Cutline;
- release-candidate notes draft evidence owned by V1 Release Notes & Upgrade Guide;
- install-path smoke-map handoff owned by Bootstrap Installer;
- upgrade and rollback evidence mapping owned by Upgrade & Migration Engine;
- compatibility surface mapping owned by Compatibility Matrix;
- support contact handoff owned by V1 Launch Support Desk & Escalation;
- missing GA release-note handoff evidence owned by HOBO-480.

The accepted M3 state keeps GA release-note and upgrade-guide handoff claims blocked until HOBO-480
records final evidence. It carries draft copy and evidence-window risks without publishing final
release notes, customer emails, docs-portal updates, compatibility guarantees, zero-downtime
upgrade promises, support response-time promises, or GA release readiness claims.

## M4 GA Handoff Evidence

Source issue: HOBO-480.

Executable proof lives in
[`../../src/draft/exp-proofs/cx/v1-release-notes-upgrade-guide-ga-handoff-evidence-contract`](../../src/draft/exp-proofs/cx/v1-release-notes-upgrade-guide-ga-handoff-evidence-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-480-release-notes-ga-handoff`](./proofs/hobo-480-release-notes-ga-handoff/index.md).

The M4 gate records GA release-note and upgrade-guide handoff evidence for:

- the M0 outline baseline owned by V1 Release Notes & Upgrade Guide;
- the M3 release-candidate handoff owned by HOBO-473;
- final release-note and upgrade-guide signoff owned by V1 Release Notes & Upgrade Guide;
- release-cutline GA signoff owned by V1 Release Program & Cutline;
- install-path smoke evidence owned by Bootstrap Installer;
- compatibility and known-limitation register evidence owned by Compatibility Matrix;
- upgrade and rollback evidence owned by Upgrade & Migration Engine;
- support contact handoff owned by V1 Launch Support Desk & Escalation; and
- docs-portal publication handoff owned by Docs Portal.

The accepted M4 state clears the HOBO-473 GA handoff gap for release-owner review and requires a
HoBo v1 Release Readiness status update because launch risk is reduced. It records no missing
evidence and creates no follow-up execution issues. Publication mechanics, docs portal delivery,
customer email, compatibility harnesses, upgrade engines, support workflow, runtime launch gates,
GA release decisions, customer-facing compatibility guarantees, zero-downtime upgrade promises, and
support response-time promises stay outside this proof.

## Proof

Executable proof lives in
[`../../src/draft/technical-proofs/v1-release-notes-upgrade-guide-contract`](../../src/draft/technical-proofs/v1-release-notes-upgrade-guide-contract/README.md).
The M1 dogfood/alpha evidence gate lives in
[`../../src/draft/exp-proofs/cx/v1-release-notes-dogfood-alpha-evidence`](../../src/draft/exp-proofs/cx/v1-release-notes-dogfood-alpha-evidence/README.md).
The M2 private-beta evidence gate for HOBO-466 lives in
[`../../src/draft/exp-proofs/cx/v1-release-notes-private-beta-evidence-contract`](../../src/draft/exp-proofs/cx/v1-release-notes-private-beta-evidence-contract/README.md)
with design proof notes at
[`proofs/hobo-466-release-notes-private-beta-evidence`](./proofs/hobo-466-release-notes-private-beta-evidence/README.md).
The HOBO-401 v1 cutline dependency is recorded by
[`v1-cutline-contract`](../../src/draft/technical-proofs/v1-cutline-contract/README.md).
The HOBO-485 customer-facing limitations dependency is recorded by
[`known-limitations-register.md`](./known-limitations-register.md) and
[`known-limitations-register-contract`](../../src/draft/exp-proofs/cx/known-limitations-register-contract/README.md).
