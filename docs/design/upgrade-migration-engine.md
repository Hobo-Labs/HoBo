---
type: Reference
title: "Upgrade And Migration Engine Scope And Acceptance"
description: "Source issue: HOBO-430."
tags: [hobo, design]
---

# Upgrade And Migration Engine Scope And Acceptance

Source issue: HOBO-430.

Executable proof lives in
[`src/draft/exp-proofs/cx/upgrade-migration-scope-contract`](../../src/draft/exp-proofs/cx/upgrade-migration-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-430-upgrade-migration`](./proofs/hobo-430-upgrade-migration/README.md).

## M0 Acceptance Record

Upgrade & Migration Engine exists to define accepted productization boundaries for version upgrades,
compatibility inputs, migration dry-runs, rollback evidence, and support handoffs before follow-up
design or implementation work fans out. This record names the people, upgrade path classes,
evidence, and owner handoffs needed before HoBo can claim customer-safe upgradeability.

## User And Business Goal

HoBo needs accepted M0 scope for Upgrade & Migration Engine so release owners, platform engineers,
DevOps operators, support, and security reviewers know which upgrade paths will be considered, what
compatibility and migration evidence must exist next, and which adjacent initiatives own runtime,
data, provider, restore, release, and support behavior. The accepted record supports launch planning
without building an upgrade runner in this issue.

## Primary Personas

| Persona | Need |
|---|---|
| Release owner | Needs beta, RC, and GA upgrade gates with evidence links and explicit accepted risk boundaries. |
| Platform engineer | Needs compatibility and migration contracts before runtime, data, provider, or installer work starts. |
| DevOps operator | Needs dry-run, backup prerequisite, rollback, and recovery evidence before self-host or hosted upgrades are attempted. |
| Support operator | Needs customer-safe upgrade status, blocked reasons, rollback guidance, and escalation ownership. |
| Security/compliance reviewer | Needs audit, backup, data handling, and unsupported-path evidence before customer upgrade promises are made. |

## Scope In

- Define upgrade path classes for hosted control plane, self-host Yard, local/dev runtime,
  SDK/package, and data-shape changes.
- Record compatibility matrix inputs: current version, target version, component-host/WIT pins,
  manifest version, data schema posture, and provider/IaC state dependencies.
- Define migration dry-run output: preflight status, required backup evidence, migration plan
  summary, blocked reasons, rollback evidence, and support handoff.
- Map service, UX, security, and support boundaries for upgrade and migration claims.
- List M1 evidence required before downstream design/build issues can begin.

## Scope Out And Non-Goals

- Do not build production upgrade runners, updater services, package manager publishing, hosted
  rollout implementation, or upgrade execution.
- Do not execute live schema migrations, data rewrites, provider/IaC state rewrites, component-host
  upgrades, or customer data migration.
- Do not implement backup restore, rollback executors, disaster recovery runners, or customer data
  recovery.
- Do not build compatibility matrix UI, release notes publication, customer communication workflows,
  or support ticket automation.
- Do not create tenant, billing, RBAC, marketplace, or installer behavior beyond the named
  dependency boundaries.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Upgrade & Migration Engine M0 defines upgrade path classes, dry-run contract shape, blocker taxonomy, rollback-evidence requirements, and M1 proof expectations. Execution services are later work. |
| UX | UX scope is the future status, limitation, and guide information architecture for upgrade paths, not a rendered compatibility matrix or upgrade wizard. |
| Security | Security scope records backup, audit, data-handling, and unsupported-path evidence without touching credentials, customer data, restore operations, or live environments. |
| Support | Support receives blocked-path reasons, rollback guidance, escalation owners, and customer-safe limitations. Support queues, SLAs, and remediation execution remain separate. |

## Upgrade Path Classes

| Class | M1 evidence shape | Out of scope here |
|---|---|---|
| Hosted control plane | Version transition record, release gate, rollback posture, support handoff, and tenant-impact classification. | Hosted rollout controller, canary execution, live tenant migration, billing or RBAC changes. |
| Self-host Yard | Source/target Yard version, offline constraints, backup prerequisite, install provenance, and operator recovery notes. | Installer changes, backup restore, disaster recovery runner, or live environment mutation. |
| Local/dev runtime | CLI/runtime version pair, component-host pin, fixture compatibility, and unsupported toolchain routing. | CLI implementation, local updater, real project migration, or developer machine scans. |
| SDK/package | Package version window, WIT/API compatibility posture, deprecation note, and consumer proof expectation. | Package publishing, generated SDK rewrites, or registry release automation. |
| Data-shape | Schema/data posture, migration dry-run facts, snapshot requirement, and rollback evidence requirement. | Live schema migration, data rewrite, projection rebuild, cross-cloud move, or provider state mutation. |

## Compatibility Inputs

M1 proof must provide a reference fixture for each supported or blocked upgrade path. The minimum
input set is current version, target version, deployment mode, component-host/WIT pin, manifest
version, contract compatibility result, data schema posture, provider/IaC state dependency,
backup prerequisite, rollback evidence link, and support handoff owner. This M0 record does not
build the compatibility matrix engine or UI; it only names the inputs the future matrix must consume.

## Migration Dry-Run Output

The future dry-run contract must return these fields before any execution work is considered:
preflight status, compatibility inputs, backup requirement, migration plan summary, blocked reasons,
rollback evidence, and support handoff. A dry-run is evidence, not execution. It must not mutate live
schema, provider state, customer data, package registries, or support queues.

**Trails extension (ADR-0134):** continuous app migration dry-runs use the Gatekeeper-compatible
`can-trail` dimension (`@hobo/trails` / `hobo trails plan`) with the same evidence posture —
dryRun, blocked reasons, rollbackPosture (`compensate-to-source`), and identity-continuous
hands-off flags. Continuous identity remains Matching/policy-driven with zero Trail authoring
(`can-migrate` / ADR-0132); Trails compose it as `identity.continuous` when apps author broader
schema/data duals.

HOBO-499 proves this M1 dry-run shape in
[`src/draft/technical-proofs/upgrade-rollback-dry-run-contract`](../../src/draft/technical-proofs/upgrade-rollback-dry-run-contract/README.md)
with deterministic clean, blocked, failed-migration, and rollback-ready fixtures plus a scope guard
that rejects live migration, rollback executor, provider-state rewrite, and support automation
requests.

## Rollback And Recovery Boundaries

Rollback evidence is required before a release or support surface may describe an upgrade path as
recoverable. The evidence may reference a prior immutable Set, pre-migration snapshot requirement,
restore prerequisite, blocked restore reason, and escalation owner. This issue does not implement
restore, rollback, disaster recovery, or snapshot orchestration.

## Authoritative Dependencies

- [release-notes-upgrade-guide.md](./release-notes-upgrade-guide.md) defines the future release
  notes, upgrade guide, support, and customer-safe limitation surfaces.
- [contracts-policy-flags.md#plan-29](./contracts-policy-flags.md#plan-29) defines compatibility
  gates and the can-deploy matrix consumed by upgrade dry-run evidence.
- [data-plane.md#plan-32](./data-plane.md#plan-32) defines event sourcing, schema migration,
  snapshot, rollback, and cross-cloud migration behavior that this issue references but does not
  implement.
- [wasm-runtime-wit.md#plan-20](./wasm-runtime-wit.md#plan-20) defines component-host/WIT
  compatibility inputs for runtime and SDK upgrade classes.
- [walkthrough.md](./walkthrough.md) defines role journeys where release owners, developers, and
  operators will encounter upgrade status and guidance.
- [ADR-0032](./adr/03-data-plane.md#adr-0032) defines event log, projection, CQRS, schema migration,
  and data ownership decisions.
- [ADR-0041](./adr/07-portability-extensibility.md#adr-0041) defines bring-your-own managed
  dependency boundaries for adopted external data stores.
- [ADR-0057](./adr/07-portability-extensibility.md#adr-0057) defines patchability and derivative
  upgrade posture.
- [ADR-0095](./adr/07-portability-extensibility.md#adr-0095) defines offline bundle pack and
  artifact lockfile constraints.

## Owning Initiative Dependencies

| Owner | Consumes from Upgrade & Migration Engine | Boundary |
|---|---|---|
| Upgrade & Migration Engine | Accepted upgrade classes, dry-run shape, blocked-reason taxonomy, rollback evidence requirement, and follow-up gate. | This issue defines scope and acceptance; it does not build runners, migrations, restores, or UIs. |
| Compatibility Matrix | Supported version, platform, component-host, and provider compatibility inputs. | Compatibility matrix engine and UI stay in Compatibility Matrix work. |
| Backup & Restore | Backup requirement and restore evidence expectations before upgrade execution. | Backup restore, snapshot orchestration, and disaster recovery implementation stay out. |
| V1 Release Notes & Upgrade Guide | Upgrade limitations, rollback guidance, known issues, and support-safe customer notes. | Publication, launch copy, and customer communication workflow stay out. |
| Support Workflow | Blocked-path reason, escalation owner, troubleshooting handoff, and rollback guidance. | Support queues, SLAs, ticket automation, and remediation execution stay out. |
| Provider/IaC State Owners | Provider and IaC state dependency facts used to block or route upgrade paths. | Drift repair, live state mutation, and provider migration behavior stay with provider/IaC owners. |
| Data Plane | Schema versioning, expand/backfill/contract, replay rebuild, and data portability facts. | Live data migration, projection rebuild, crypto-shred, and cross-cloud move implementation stay in Data Plane. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Upgrade scope record | Release owner | This document | Design record | Upgrade path classes, personas, boundaries, and non-goals are accepted. |
| Compatibility input matrix | Platform engineer | Compatibility inputs section | Reference fixture | Current and target versions, platform support, component-host pins, and provider dependencies are named before execution. |
| Migration dry-run contract | Platform engineer | Migration dry-run output section | Contract test | Dry-run output contains preflight, backup, migration plan, blocked reason, rollback, and support facts. |
| Rollback evidence fixture | DevOps operator | Rollback and recovery boundaries section | Reference fixture | Rollback evidence is required before support or release can describe an upgrade path as recoverable. |
| Release notes support handoff | Support operator | Release notes dependency | Support handoff | Release notes, upgrade guide, troubleshooting, and escalation inputs are named without publishing them in this slice. |
| Scope boundary register | Security/compliance reviewer | Scope out and non-goals | Policy fixture | Live migration, rollback execution, backup restore, provider state mutation, UI, and support automation are routed out. |

## M1 Dogfood/Alpha Evidence

Accepted state: every row of the M1 evidence table above is delivered as production code in
`@hobo/trails` (`packages/trails/src/upgrade-preflight.ts`), promoting the HOBO-499
`upgrade-rollback-dry-run-contract` proof (frozen in the promotions ledger).

1. Upgrade scope record — this document (HOBO-430, accepted).
2. Compatibility input matrix — `COMPATIBILITY_INPUT_MATRIX`: one reference fixture per upgrade
   path class carrying the full 11-field input set, round-tripped through
   `parseCompatibilityInputs` (parse-don't-validate).
3. Migration dry-run contract — `evaluateUpgradeDryRun` + the deterministic clean / blocked /
   failed-migration / rollback-ready fixtures; reports carry preflight, backup, migration plan,
   blocked reasons, rollback, and support facts with a stable digest and an always-empty
   `mutationCommands`.
4. Rollback evidence fixture — `parseRollbackEvidence` refuses `available`/`recoverable` claims
   without a concrete immutable-Set or snapshot ref.
5. Release notes support handoff — `SupportHandoffRecord` on every dry-run report names owner,
   handoff, next action, and escalation without publishing anything.
6. Scope boundary register — `UPGRADE_SCOPE_BOUNDARIES` (all six scope-out categories with owning
   routes) + `assertUpgradeScopeBoundary` failing closed on live-execution asks.

## M2 Private Beta Evidence

Accepted state: the first live executor slice exists behind ports — expand → backfill → contract
as gated saga steps over a real store (ADR-0032 §3-4), delivered as
`packages/trails/src/{schema-apply-port,migration-executor}.ts`.

1. Real DDL/DML execution per phase with a mandatory pre-migration snapshot
   (`migration.SnapshotTaken` before any mutation).
2. The destructive contract phase is compatibility-gated: consumers still reading the old shape
   BLOCK the drop (`contract-blocked`), and the expand/backfill dual window stays open — blocked is
   not failure.
3. Verification points (`after-backfill`, `after-contract`) run violations queries; any violation
   restores the pre-migration snapshot (`migration.RolledBack`; forward-only, no `.down` scripts).
   Since [ADR-0177](./adr/03-data-plane.md#adr-0177) the restore is decided first
   (`migration.RollbackDecided`) and needs a `replayErasures` callback: without one a failed phase
   holds instead of restoring, so a rollback cannot bring back an erased subject. Every phase is
   write-ahead (`migration.PhaseIntended` before its statements): a run that finds an intent with
   no `migration.PhaseApplied` after it asks the plan's probe for that phase
   (`DataMigrationPlan.probes`) instead of re-applying or restoring, and holds with
   `PHASE_OUTCOME_UNKNOWN` when the plan has none. A held or interrupted migration resumes only
   when `executeDataMigration` is given a `journal`; without one every call starts from nothing.
4. The full `migration.*` event family is emitted and catalogued in
   [event-families.md](./event-families.md); shapes are pinned in
   `packages/trails/data-models/migration.proto`.
5. Carried risk: SQLite is the only live `SchemaApplyPort` binding; managed-Postgres bindings stay
   with Data Plane per the owning-initiative table. **Resolved by
   [ADR-0177](./adr/03-data-plane.md#adr-0177):** the SQLite binding moved to
   `@hobo/data-sqlite`, `@hobo/data-postgres` and `@hobo/data-mongodb` implement the same
   `@hobo/data-core` contract, and `@hobo/trails` imports no engine
   ([data-engines-continuous-migration](./data-engines-continuous-migration.md)).

## M3 Release Candidate Evidence

Accepted state: the pooled → siloed zero-loss protocol (ADR-0080 §2) runs against real
SQLite-backed ports (`packages/trails/src/{tenant-move-port,data-dual-port}.ts`) driven through the
identity spectrum-cutover protocol.

1. Suspend/fence refuses the moving tenant's writes at the store's single write entry point
   (`FencedTenantError`); other tenants keep writing.
2. Drain replicates the CDC tail to lag 0 — the quiescent seq; export cuts at that seq; import
   verifies the silo row set; the conformance test asserts `source quiescent seq == silo head`
   with zero lost or duplicated rows (the imported head is measured from the silo watermark, not
   echoed).
3. Source reap is destructive and refused unless the tenant is fenced, lag is zero, and the
   source/silo row sets are checksum-equal.
4. Brownfield stores are covered by `backfill()` (snapshot-then-tail).
5. **Upgrade and rollback evidence mapping** (consumed by
   [release-notes-upgrade-guide.md](./release-notes-upgrade-guide.md) M3): dry-run reports map to
   release-notes inputs via `releaseNotes.requiredInputs`; rollback guidance maps to
   `RollbackEvidence` (state, refs, restore prerequisite, escalation owner); blocked paths map to
   `blockedReasons` + `unsupportedPath.remediation`.

## M4 GA Handoff Evidence

Accepted state: schema-evolution safety is a CI gate, and the evidence mapping is handed off.

1. Golden-replay corpus + upcaster-totality gate promoted into `@hobo/events`
   (`packages/events/src/upcaster.ts`, from `event-body-upcaster-gate`): every shipped
   (type, version) pins a real encoded body; CI replays all entries through the current upcaster
   chain; coverage, totality, purity, and append-only baseline violations fail the test lane and
   with it can-deploy.
2. The `migration.*` wire shapes are pinned in the corpus
   (`packages/events/corpus/golden-replay-baseline.json`, append-only): bumping any migration
   event body requires a total upcaster plus a new corpus entry. That rule has since been
   exercised: `migration.Planned`, `migration.PhaseApplied`, `migration.CutOver`, and
   `migration.RolledBack` are at v2, each with an upcaster from its pinned v1 body, and
   `migration.FenceRequested`, `migration.FenceRaised`, `migration.PhaseIntended`, and
   `migration.RollbackDecided` were added at v1
   ([event-families.md](./event-families.md), [ADR-0177](./adr/03-data-plane.md#adr-0177)).
3. GA handoff mapping for [release-notes-upgrade-guide.md](./release-notes-upgrade-guide.md) M4:
   the M3 evidence mapping above plus the corpus gate as the "no unliftable stored event" claim.
4. Carried risks (explicit, not silently closed): production restore orchestration stays with
   Backup & Restore. The ADR-0134 residual — live change capture and dual runs beyond
   SQLite-shaped fixtures — is addressed by [ADR-0177](./adr/03-data-plane.md#adr-0177): real
   change capture for PostgreSQL (logical decoding) and MongoDB (change streams) behind one
   engine contract, each run against the engine conformance kit on a live server (the dated
   record is in
   [data-engines-continuous-migration §9](./data-engines-continuous-migration.md#last-recorded-run)).
   Those live lanes now run in CI (the `Live data engines` job: on pull requests whose diff
   reaches them, and nightly); what remains carried is that the job is not in the merge queue's
   required set. The intermittent failure once seen in the live PostgreSQL lane has a root cause and
   a fix — a capture slot is now proven decodable before use — with one residual, the table-sync
   slots PostgreSQL creates itself ([§10](./data-engines-continuous-migration.md#10-honest-limits)).

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted.
**Status: M0 was accepted; the ladder above records the delivered M1-M4 evidence.** The executable
guard (`canCreateUpgradeMigrationFollowUp`) remains the gate for any future phase labels.
