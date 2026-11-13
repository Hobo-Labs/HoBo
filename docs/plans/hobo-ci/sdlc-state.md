---
type: Delivery State
title: "HoBo CI delivery state"
description: "Durable delivery history and coordination state for the HoBo CI implementation."
tags: [ci, delivery, state]
---

# HoBo.CI delivery state

## Local runner Pact Broker validation — 2026-10-29

- Implemented sequentially on `test/ci-local-pact-broker`, without delegation.
  The lane uses Pact JS 17.1.4, its native mock server/verifier and a real
  digest-pinned PostgreSQL-backed Pact Broker bound to loopback.
- Generated consumer contracts cover 31 relay interactions and 16 GitHub CLI
  interactions. The runner host's shipped JIT HTTP consumer is exercised directly;
  the actual relay request handler verifies every owned-provider interaction.
- Broker publication records branch and source version. Exact-version matrix
  checks approve verified pairs and reject missing verification, failed provider
  verification, skew and replacement of immutable consumer contracts. An
  intentionally broken provider publishes a real failure under a separate
  negative-control version/branch.
- GitHub's provider-version selector is independent of HoBo's consumer/source
  version. It defaults to an explicit unverified sentinel and can use an
  independently verified upstream version from the shared broker.
- Before publication, native process/socket/lifecycle tests, all 50 act corpus
  jobs, two zero-budget connected local executions, capacity withdrawal/replay
  and three rejecting acceptance faults must pass. Validation also passed 573
  Actions tests, 247 Vercel tests and direct touched-script/test typechecks.
- GitHub consumer expectations are published, but no local simulator is labelled
  a verified GitHub provider. The broker reports that external boundary unknown;
  `pact:can-deploy` exits nonzero. Successful local validation is not full live
  production approval. See the [broker scenario inventory](../../../packages/ci-gh-actions/contracts/LOCAL-RUNNER-PACT.md).

## Local runner end-to-end hardening — 2026-10-29

- Follow-up to merged #1612, implemented and reviewed sequentially in this
  session at the user's request; no work delegated.
- Fixed clean-container bootstrap under the actual nonroot user: Corepack
  installs workspace-local shims instead of failing to write `/usr/local/bin`.
- AbortSignal cancellation now drains an active host process group before
  deleting its registration/workspace. Stop retains blocked recovery status for
  unfinished cleanup, waits for singleton-lock release, and reports unknown
  when recovery state cannot be inspected.
- Added executable `test:acceptance --local`: two zero-budget local jobs through
  the shipped relay/outbox/OIDC/JIT/host/settlement path, capacity withdrawal,
  durable restart and completion replay. Missing JIT, wrong provider and skipped
  job fault runs all fail. GitHub and identity issuance are strict local fixtures.
- Validation: 556 Actions tests and 247 Vercel tests, 50 real act corpus jobs,
  seven existing-provider and two local-provider connected acceptance executions,
  and direct touched-script/test TypeScript checks passed. The generated Vercel
  bootstrap snapshot was regenerated from source.
- Live acceptance was attempted: the current GitHub integration rejected creation
  of a disposable private repository (`Resource not accessible by integration`).
  No unrelated private repository was used, no runner registered, and live GitHub
  assignment is not claimed. The complete layered devcontainer build hit this
  environment's 32 GB disk limit; the nonroot shim path was independently executed
  successfully in the base runtime. These are verification limits, not delegated
  follow-up implementation tasks.

## Local development runner closeout — 2026-10-29

- Delivery: [PR #1612](https://github.com/Tyler-R-Kendrick/HoBo/pull/1612),
  branch `feat/ci-local-runners`; local implementation and review complete,
  squash-merge authorized after final review/check reconciliation. The PR records
  the authoritative merge outcome.
- `local` offers preserve the existing lease/OIDC/JIT bridge, use the separate
  `hobo-local-host` host label, permit one zero-price job, and retain fresh
  availability requirements. Dev containers install the needed runtime/Docker/
  GitHub/act tooling and start the controller automatically.
- Self-review and independent review resolved ambiguous registration retries,
  malformed-response cleanup, false stopped status, an invalid test type import,
  valid dotted/dashed repository names, and the listener-age watchdog cutting
  short a job accepted after a long idle period. Regressions cover each repair.
- Validation: 674 CI/Actions package tests, all 11 PR-base relevant checks,
  touched scripts/tests typechecked, generated schema/Protobuf/CUE checks, and
  50 executed act jobs across 11 scenarios. The base image and nonroot official
  runner/startup/drain paths were exercised locally.
- Developer-experience consensus is required for the CLI/configuration/docs;
  its current-head decision and final assertion are recorded with the PR review.
- Boundary: real GitHub assignment remains unverified. The live bridge needs
  a private trusted Linux x64 repository, authenticated GitHub runner authority,
  an active relay connection and fresh local offer evidence. Offline act does
  not require those credentials. See [local development](../../../packages/ci-gh-actions/LOCAL-DEVELOPMENT.md).

## Earlier delivery state

- Current phase: lowest-cost routing implementation and managed Vercel hosting planning
- Current branch: `feat/ci-cheapest-routing`.
- Prior production PR: [#1596](https://github.com/Tyler-R-Kendrick/HoBo/pull/1596),
  squash `4e2e7ca2c0360224e3beb1a982834e80495bb3d8`.
- Prior SDK delivery: [#1594](https://github.com/Tyler-R-Kendrick/HoBo/pull/1594),
  squash `a262136d98e6699f8093c45fb36e32ea0a931864`; its closure record was #1595.
- Current user acceptance: deployable service and a testable `runs-on: hobo` branch,
  not an experimental/scaffold-only release.
- Parent owns shared contracts, composition, docs, gates and PR delivery.
- Isolated implementation/review covered onboarding, runtime lifecycle,
  deployment, connected acceptance, host shutdown and workflow policy.

## Selected hosting follow-up

The user selected Vercel hosting that exposes a public relay. Functions/Services
will receive GitHub webhooks, policy/onboarding requests and OIDC/JIT claims;
transactional external state and queue-driven workers will own durable admission
and reconciliation. An outbound Daemon is optional for continuous polling, not
the public HTTP listener. Existing SQLite/container assets remain self-hosted
adapters and regression references, not a prerequisite VM deployment.

The hosting and policy plan records the source
audit, official platform constraints, adversarial/YAGNI/rubber-duck passes,
SDK desired-state and Station Connection design, and contract-based delivery
slices. Implementation and resource provisioning have not started in this
follow-up. The user requested lowest total cost and temporary execution; routing
compares projected charges after applicable free allocation. The Vercel adapter
and temporary preview deployment remain planned work. No hosting accounts, secret
inventories or other repositories were probed, and no provider resource was
created. Separate architecture and
adversarial reviews identified and closed the legacy-write, Connection-resolution,
identity-linking, shared-parent-budget and repair-schedule gaps. Scoped CLI/design
documentation checks and relative-link checks passed. The current branch also
updates runtime ranking and its regression tests for lowest projected cost.

## Production repairs

Persistent account policy/operation state, tenant-scoped authenticated API,
repository setup PRs and verified protected pins, token-bound installation authority,
secret-file deployment, process owner fencing, bounded drain, process-group cleanup,
private-repository bridge fencing, async revocation fencing, paginated discovery, inclusive
usage snapshots, monotonic ready operations and readonly-backup restore are implemented.
The Station bridge consumes actual Broker budget facts and persists threshold
ordering with account policy. Independent review found dispatch/JIT authority
revocation races; both are fixed with deferred-request regression tests.
Validation passed: 588 tests across CI/Actions/Dagger/Cloudflare/Stations,
16 relevant staged gates, generated protobuf/CUE checks, seven connected act
executions with three rejecting fault runs, and seven actual container checks.
Final image: `sha256:bc5b475c243ccb2ec172575dde3669cf4b178559b2e77a1e0833775e20d2a7cd`.
Thirteen compiled runtime modules match fresh compilation of the source.
PR-base validation passed all 16 relevant checks. The first exact-six design
review identified two documentation contradictions: obsolete spend-baseline
instructions and a live-test recipe that replaced the reviewed manual workflow
with the local act fixture. Both instructions were corrected; the refreshed
cycle1 review unanimously approved head `976919abe63fe1244792f1fdbe9c65bc40df2eea`
before #1596 was squash-merged.

The two independent P2 findings are resolved: dispatch re-resolves authority after
GitHub reads; JIT rechecks original branch/event authority after host checks.
The independent reviewer reran 27 lifecycle/revocation regressions successfully.
Runtime/backups execute without root; persisted threshold flags reject rollback
with HTTP409 and survive actual service restart.

## Evidence and boundary

Actual local act execution, full connected protocol tests and the nonroot image
lifecycle are independently observable. An actual GitHub queue/vendor run remains
unverified: runner-management API permission was HTTP403, and automatic approval
review rejected an additional optional live probe under the prior contract-only
scope. No extra repository/App/provider resource was created to bypass this.

The active acceptance workflow is manual-only and has literal `runs-on: hobo`;
all preserved hosted CI remains disabled. Do not label a local/permission/identity
check as successful remote runner execution. See README for exact test commands.

## Prior review history

The original SDK head `56fdbe73b6f09dc3a39b94bb5f8310cc17e4fb9b` passed
238 package tests,22 protocol regressions,19 PR-base checks and40 actual act jobs.
Its exact-six SDK/DX review was unanimous yay (cycle2,
`sdk-closeout-cycle-2-consensus`; proposal
`2251301bd67552f2e0337c69a4de34ef99e051a7520ac30ec247a1601188ee7e`).
That approval applies to that historical head, not the production continuation.
