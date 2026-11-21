---
name: verify-ci-start-binding
description: Check transactional CI fleet start-binding, GitHub assignment evidence, and pre-job hook receipts.
---

# CI fleet start binding

**Property:** A job has at most one durable slot claim, a slot has at most one job claim, and only the same assignment, claim and credential can receive a prior nonterminal start receipt. A terminal or uncertain claim cannot authorize a start again. The scoped GitHub lookup rejects conflicting or incomplete evidence, and the pre-job hook proceeds only for a matching receipt and valid runner context.

**Why:** Two different runner slots must not receive start authorization for the same actual job, and a changed request must not be treated as the original committed authorization.

**Store result at sync commit `1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded`:** PASS for the stated SQLite and PostgreSQL contract cases, generated retry cases, the bounded model, and the mathematical induction below. **Hook result at sync commit `afc5877e3655a2ffb22a817c1cf161ce823111ab`:** PASS for the local HTTP tests and bounded receipt model below. **Lookup result at sync commit `b353fb8d0b30e86870068e2420b8dfd13c938a49`:** PASS for the generated and mocked GitHub checks and bounded assignment model below.

## Covered code

- `packages/ci/src/fleet-v2/{sqlite,postgres}-strict-store.ts`, `parse.ts`, and `state-machine.ts`.
- `packages/ci/test/fleet-v2-store-conformance.test.ts`.
- `packages/ci-gh-actions/templates/fleet-pre-job-hook.sh` and `packages/ci-gh-actions/test/fleet-start-hook-receipt.test.ts`: context and receipt validation at the hook boundary.
- `packages/ci-gh-actions/src/fleet-v2/github-assignment.ts`, `src/github.ts`, `src/fleet-v2/start-fence.ts`, and `test/strict-github-assignment.test.ts`: scoped assignment evidence and its comparison with a hook claim.
- The lookup and hook are not wired into the production controller. The live endpoint and GitHub behavior are not proved here.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-start-binding
```

The command runs the shared conformance suite on SQLite, the hook tests against a local HTTP server, mocked GitHub lookup tests, bounded TLC 1.7.4 models, and an abstract unbounded uniqueness induction with Z3 4.15.4. It checks PostgreSQL too when `TESTCONTAINERS=1`, `HOBO_FLEET_ENROLLMENT_CI=1`, or `HOBO_CI_TEST_POSTGRES` supplies a test database. The container route requires Docker and the test's pinned PostgreSQL image. Java 11+, Python, Node, Bash, curl, Vitest, fast-check, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned installations for an offline run. Use `/statechart` with the `models/*view.mts` projections to regenerate the charts.

## Scope and evidence

The real-store conformance suite races two registered slots for one actual job, checks one committed claim and an identical retry, and generates 150 combinations of matching or mismatched runner, profile, secret and claim. It checks that retries do not append events and that a completed claim cannot authorize again. The same suite passed with SQLite and a PostgreSQL 17 test container at the sync commit. The fleet-column migrations, exhaustion guards, and uncertain-slot recovery change availability and settlement, not the modeled assignment binding; the conformance suite checks those boundaries separately. It does not cover a live GitHub runner, process crashes, network failures, or every possible database schedule.

TLC explores two jobs and two slots (213 reachable states). A boolean abstracts all checks that must match for a receipt; a terminal boolean abstracts terminal and uncertain claims. A committed job-to-slot association remains a tombstone. The model checks that neither a job nor a slot is rebound and that an accepted receipt matches a nonterminal binding. Removing the retry-match guard violates `ReceiptValid`; removing slot uniqueness violates `NoSlotRebinding`. Removing the implementation's retry-assignment check in a scratch SQLite copy causes the conformance test to fail.

StartHookReceipt explores 285 states for valid or invalid runner context, HTTP status, receipt shape and identity, and abstract committed and nonterminal state. The hook calls the endpoint only for valid context and proceeds only for HTTP 200 with a matching receipt. The model assumes a trusted endpoint and authenticated, fresh response: a matching receipt is issued only after the authorization commits and while it is nonterminal. Its projection hides 114 same-state transitions. The model does not represent state changes between receipt and workflow start, the live endpoint, GitHub assignment, or transport authentication. Three behavior mutations violate invariants; removing the trusted-commit or nonterminal assumption also produces counterexamples.

The hook tests exercise a real local HTTP server in 23 tests, including 25 generated receipt-identity changes with seed 614476. They reject redirects, empty, malformed, oversized, rejected or mismatched responses, and malformed or stale run context. Six real-hook mutations that ignore status, rejection, claim or job identity, context, or response size fail the tests. The hook sends the binding secret in the request body, and the tests check that it is absent from stdout and stderr.

StrictGithubAssignment explores 128 states for abstract trusted scope, runner identity, group and required labels, uniqueness, current evidence, and complete scan. It checks that every accepted assignment satisfies each condition; the projection hides 64 same-state transitions. Removing any one of the six modeled guards violates its invariant. The real-code tests exercise the GitHub-derived key, forged claims, conflicting runner identities or group/labels, multiple jobs, changed status or attempt, truncated scans, and pinned scope, plus 50 generated job IDs with seed 614477. Twelve code mutations that omit those checks fail tests. The CI Actions suite passed 1,941 tests with 10 skipped, and 310 root tests passed.

The lookup assumes its scope and GitHub transport come from trusted controller configuration. It scans one repository and fails closed when required runner-group, label, attempt, or complete-listing evidence is unavailable. Required labels alone do not establish the full execution profile. GitHub's paginated responses are not an atomic snapshot, and an assignment can change after the final read. The model abstracts these observations as fixed booleans and does not establish live GitHub behavior, TypeScript refinement, or fencing across that race.

Z3 proves that an abstract atomic assignment preserves unique slot ownership for unbounded integer job and slot identifiers, assuming the initial mapping is unique, the job has no prior owner, and the slot is unused. `START_BINDING_PROOF_MUTATION=omit-slot-guard` produces a counterexample. The proof does not establish that TypeScript refines this model, that a database transaction or GitHub's assignment evidence works as assumed, or that runner code executes exactly once. The store trusts the caller's verified-assignment assertion. See the operator guide for the unwired production lookup and hook endpoint.

## Keep in sync

Review covered code changes, update the executable checks and model for intended behavior, replay counterexamples against the stores, run both database implementations and deliberate scratch mutations, regenerate the chart, and advance the sync commit only after confirming correspondence. Use `/maintain-formal-verification-skill`.
