---
type: CI Performance Finding
title: "Finding 156: merge group PR Fabric tree match rate"
description: "90% of successful merge_group Fabric runs test a tree the pull request's own last green Fabric run already tested at the same base and workflow, so the merge-group gate can reuse that run and skip the heavy jobs."
tags: [hobo, ci, performance, merge-queue, reuse]
---

# Finding 156: merge group PR Fabric tree match rate

## Evidence

The last 50 successful `HoBo CI Fabric` `merge_group` runs were analyzed
against the last green `pull_request` Fabric run of the same pull request head
before the merge group started:

| Signal | Rate |
| --- | ---: |
| Tree match (merge-group head tree vs the PR run's tested merge-commit tree) | 90% (45/50) |
| Base match (queue branch encoded base vs merge-group parent) | 98% |
| Both tree and base, when a green PR run exists | 90% (1 of 50 had no green PR run) |

The 5 tree mismatches are base movement between the pull request's run and
the queue's snapshot: main advanced, the merge group merged onto a newer tip,
and the resulting tree is one no pull request run tested.

Methodology: the merge-group run's `head_branch` is parsed as
`gh-readonly-queue/main/pr-<n>-<base>` to get the pull request number and the
base the queue encoded; the pull request's runs are listed from the Actions
API filtered to `event=pull_request` on that head; for the newest green run
before the merge group, the tested tree (the merge commit's tree, read
through the GitHub commits API, not the PR head tree), the tested base (the
merge commit's first parent) and the workflow file blob are compared with the
merge-group run's checked-out tree, its queue-branch-encoded base and the
workflow blob this reuse trusts. `pulls` `merge_commit_sha` and the merge API
serve the same comparison when a run's own head is not yet enriched.

## Change

- **`scripts/ci/pr-fabric-reuse.mts`** decides reuse in the route job, on a
  GitHub-hosted machine, before any runner is queued for the gate: a
  merge-group run may skip its heavy gate jobs when the pull request's last
  green `pull_request` run of this workflow tested this exact tree (merge
  commit tree), against the base the queue branch encodes, with the workflow
  file blob pinned in `attestation.mts` (`SHADOW_WORKFLOW_BLOB`). Same
  repository only: a fork head (`head_repository` ≠ repository) refuses, a
  run of another repository or event is not a candidate, and a pull head that
  moved after its green run refuses. The decision never throws and never
  fails the job: anything short of a verified match is `pr-fabric-green=false`
  and the merge group runs its full gate.
- **The route action** (`.github/actions/route-runner`) runs the script from
  the trusted base checkout (like the attestation verifier) and outputs
  `pr-fabric-green` / `pr-fabric-run`; `hobo-ci.yml`'s route job forwards
  them.
- **On `pr-fabric-green`**, the covered merge-group gate jobs
  (`pr_gate_validation`, `workspace_tests`, `scripts-tests`) are skipped the
  same way attested jobs are, and the `pr-gate` required check accepts the
  skipped jobs only when the route job itself succeeded and reported the
  reuse. The cheap subset still runs: `secret-scan` scans the merge group's
  `base..head` range and `ci-guard` asserts the CI fabric contract, exactly
  the checks the skipped PR impact validation would have contributed.

## Verification

- `scripts/test/pr-fabric-reuse.test.ts`: match, tree mismatch, base
  mismatch, fork head repository, stale head, failed PR run, tampered
  workflow blob, wrong event, cross-repo run, unparseable queue branch,
  enrichment of the tested commit's tree/parents/blob, fetch URL shape and
  fail-closed reads, plus the workflow and action wiring.
- `scripts/test/merge-group-gate.test.ts`: the gate still refuses every
  failed/cancelled/unknown prerequisite and accepts a skipped job only for a
  route job that succeeded and vouched for it.
- `scripts/test/attested-jobs.test.ts`: the shadow plan and workflow blob
  pins updated for the new conditions (local runs still execute every
  covered job; the local context answers `pr-fabric-green=false`).
- `scripts/lint-actions.ts` accepts the new conditions.

## Risks

- The reused evidence is the pull request's own run on this repository, not
  an independent merge-group test; the tree+base+workflow match is what makes
  it the same test. The 10% mismatch cases pay the full gate, not a wrong
  skip.
- The workflow blob pin means a PR run from before the last workflow edit
  never reuses: reuse warms up as pull requests run against the new base.
- A merge group whose pull request has no green run (or a stale one) runs
  the full gate, so the queue's latency floor is unchanged where reuse does
  not apply.
