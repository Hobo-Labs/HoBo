---
type: Reference
title: "HOBO-433 Upgrade Test Suite M0 Scope Proof"
description: "Source issue: HOBO-433."
tags: [hobo, design]
---

# HOBO-433 Upgrade Test Suite M0 Scope Proof

HOBO-433 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/upgrade-test-suite-scope-contract`](../../../../src/draft/exp-proofs/dx/upgrade-test-suite-scope-contract/README.md)
and the durable scope record at [upgrade-test-suite.md](../../upgrade-test-suite.md).

## Acceptance Evidence

- Goal and personas are explicit for release owners, platform engineers, DevOps operators, support
  operators, and security reviewers.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Scenario classes cover hosted control-plane, self-host Yard, local/dev runtime, SDK/package, and
  data-shape upgrades.
- Required evidence fields cover source version, target version, deployment mode, compatibility
  matrix reference, preflight result, backup/restore proof, migration plan, rollback proof, security
  review state, and support handoff.
- Result states define passed, blocked, unsupported, needs-manual-review, waived-with-risk, and
  failed outcomes.
- Dependencies map Upgrade & Migration Engine, Compatibility Matrix, Backup & Restore, Bootstrap
  Installer, Release Notes, Tenant Data Lifecycle, Security Verification, Support Workflow,
  ADR-0032, ADR-0041, ADR-0042, ADR-0057, and ADR-0082.
- M1 evidence is listed as scenario matrix, fixture corpus, preflight contract, migration dry-run
  report, rollback drill fixture, compatibility result schema, and support troubleshooting map.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects production upgrade runners, live migrations, live restore/rollback,
  compatibility UI, release publication/approval, support automation, real secret collection, and
  customer-environment scans.
- Evidence validation rejects records missing required upgrade evidence such as rollback proof.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Gate Evidence

- TypeScript proof: `pnpm --prefix src/draft/exp-proofs/dx/upgrade-test-suite-scope-contract test`.
- Protobuf/CUE proof: `pnpm test:schema` checks repository schema validators; package-local data-model folders own data model
  contracts including `UpgradeTestSuiteScopeRecord`.
- PACT proof: `architecture/pacts/upgrade_test_suite_scope.pact.json` pins the M0 scope acceptance
  consumer expectations.
- Local gate note: Turbo is pinned to `2.8.6` because the `2.9.0` through `2.10.1` Windows package
  currently starts with a missing `ghostty-vt.dll` loader dependency on this host; staged checks still
  run the normal Turborepo package-test lane.
