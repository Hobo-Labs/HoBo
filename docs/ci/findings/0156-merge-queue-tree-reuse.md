---
type: CI Performance Finding
title: "Finding 156: merge queue tree reuse"
description: "15 of the last 50 merge_group Fabric runs (30%) tested a tree a green same-repo pull_request Fabric run had already tested at the same base tip; the route job now verifies that shape and skips the merge-group gate jobs for it."
tags: [hobo, ci, performance, merge-queue, github-hosted, reuse, trust]
---

# Finding 156: merge queue tree reuse

## Evidence

The last 50 `merge_group` runs of HoBo CI Fabric before 2026-11-20 16:45 UTC
(created 2026-11-19 01:00 through 2026-11-20 15:58; 48 green, 2 failed), read
through `gh api`. Every number below is GitHub's own: trees come from the
commits API, the base tip from the run's `gh-readonly-queue/main/
pr-<n>-<base40>` branch name cross-checked against the head commit's first
parent, ancestry from the compare API.

### What each merge group tests

A merge_group run's head commit is the queue's own merge of the entry's base
tip with the PR head; the branch name carries both (`pr-<n>-<base40>`), and
`<base40>` equals the head commit's first parent in all 50 runs. A
`pull_request` Fabric run reports `head_sha` = the PR head commit (a
single-parent commit, not GitHub's merge ref), and it checked out
`refs/pull/<n>/merge`: the merge of the then-main tip with that head.

So the tree the PR run tested equals the merge group's tree exactly when the
PR head's own tree is already the merge result at the queue's base — the PR
branch has absorbed the base, and every merge of any earlier main tip with the
head resolves to the head's own tree. The PR run's lane selection against its
older base was then a superset of the merge group's (it diffed
`<older base>...head`, which contains `<base>...head`).

### Measurement

For each of the 50 merge_group runs: parse `pr-<n>-<base40>` from the branch
name; find the PR's newest green (`status=success`) same-repo `pull_request`
run of `hobo-ci.yml` whose `head_sha` is the current PR head and which was
created before the merge_group run; compare tree(PR head) with tree(merge
group head); fail closed when the compare API's merge base of `<base40>` and
the PR head is not `<base40>` itself.

| Outcome | Runs | Share |
| --- | ---: | ---: |
| tree equal, base contained in head (reusable) | 15 | 30.0% |
| base moved: PR head diverged behind the entry's base | 33 | 66.0% |
| no green same-repo PR Fabric run for the current head | 2 | 4.0% |
| tree differs while the base is contained | 0 | 0.0% |

15 of the 48 green merges (31.3%) could have reused their PR's Fabric result.
Reusable pairs, cited: PR [2093](https://github.com/Hobo-Labs/HoBo/actions/runs/44671620627)
→ merge group [44673249729](https://github.com/Hobo-Labs/HoBo/actions/runs/44673249729);
PR [2912](https://github.com/Hobo-Labs/HoBo/actions/runs/44650389613) →
[44652732574](https://github.com/Hobo-Labs/HoBo/actions/runs/44652732574);
PR [2889](https://github.com/Hobo-Labs/HoBo/actions/runs/44634397168) →
[44637704610](https://github.com/Hobo-Labs/HoBo/actions/runs/44637704610);
PR [2879](https://github.com/Hobo-Labs/HoBo/actions/runs/44621689469) →
[44624606873](https://github.com/Hobo-Labs/HoBo/actions/runs/44624606873);
PR [2647](https://github.com/Hobo-Labs/HoBo/actions/runs/44436269830) →
[44437880325](https://github.com/Hobo-Labs/HoBo/actions/runs/44437880325);
also PRs 2855, 2845, 2823, 2815, 2801, 2799, 2795, 2476, 2475, 2673.

**False negatives** (the 35 non-reusable runs):

- **Base moved (33).** Main advanced between the PR's last green run and the
  enqueue, and the PR branch never absorbed it: the merge base of the entry's
  base tip and the PR head sat behind the base ("diverged"). Today's merges
  are all here — PR 2016's merge group [44768600406](https://github.com/Hobo-Labs/HoBo/actions/runs/44768600406)
  against PR run [44766571780](https://github.com/Hobo-Labs/HoBo/actions/runs/44766571780):
  base `e4693b47`, merge base `5c496290`. Requiring the PR to be current with
  the queue's base (rebase or update-branch) would move these into the
  reusable column; nothing here does.
- **No green run for the current head (2).** PR 2308's merge group
  [44667408293](https://github.com/Hobo-Labs/HoBo/actions/runs/44667408293)
  (it failed): the green run 44665737745 tested head `a28ecad4`, the head at
  enqueue was `0116ead4` — the run predates the PR's last push. PR 2084's
  merge group [44436525943](https://github.com/Hobo-Labs/HoBo/actions/runs/44436525943)
  had no green run after the PR's final synchronize. Both fail closed.
- **Batching.** Every one of the 50 entries named exactly one PR
  (`min_entries_to_merge=1` with the observed arrival rate), so no batch merge
  shape appears in the sample; a batched group would carry a merge tree no
  single PR run tested and fail the tree comparison.
- **Workflow drift.** A change to `hobo-ci.yml` between a PR's green run and
  its merge is a tree difference (the workflow file is part of the tree), so
  it falls out of the tree equality; the measured zero
  "tree differs while base contained" rows includes this.

**Why the earlier number was wrong.** A pre-sample compared the merge group's
tree with the PR run's head-commit tree and ignored the base in the branch
name: 16/49 (32.7%) tree-equal. Its extra match is the false positive the
base-and-head checks exist to refuse: PR 2308's failed merge group above,
whose green run had tested a stale head on the same tree-by-coincidence path.
The corrected rule also refuses any run whose head is not the PR's current
head, whose head repository is not this repository, or which the compare API
does not show containing the base tip.

## Cause

The merge queue re-validates because it must, not because the content changed:
a merge group at base B with PR head H tests `merge(B, H)`, and a PR run that
tested the same H with B already inside it ran the same content against a
wider diff. Nothing asked whether that shape held; every merge paid the full
gate ([154](./0154-main-waited-for-runners-between-jobs.md) made the same
observation for main and fixed that side).

## Fix

**`scripts/ci/pr-fabric-reuse.mts`**, run by the `route` job from the trusted
base checkout (`.ci-trusted`, the merge group's base tip — never the
candidate's own tree, so a pull request cannot vouch for itself with its own
copy of the decision or of the policy). It never fails the job: anything
short of a verified match is `reuse=false` and the merge group runs as before.

### Trust model

Reuse of a green PR Fabric run holds only when every one of these is verified,
and each is a GitHub answer, not an event or branch value taken on faith:

1. **Same-repo PRs only.** The green run's repository and head repository are
   both this repository; fork runs are refused.
2. **A green run of this workflow bound to this merge entry.** The workflow
   API lookup is `/actions/workflows/hobo-ci.yml/runs`, and each returned run
   must have `event=pull_request`, `status=completed`, `conclusion=success`,
   and `path` exactly `.github/workflows/hobo-ci.yml`. Its `pull_requests`
   association must include the `<n>` named by the merge-queue branch, with
   that pull request's recorded `base.ref` equal to `main` and `base.sha`
   equal to `<base40>`. A successful run on the same branch without that
   association is not evidence for this entry.
3. **The base tip matches.** The `<base40>` parsed from
   `gh-readonly-queue/main/pr-<n>-<base40>` must equal the event's
   `merge_group.base_sha` (GitHub-generated context, passed by the action) and
   the merge head commit's first parent.
4. **Tree SHAs are the commit API's**, for both the merge-group head and the
   PR head the green run reports; the branch name supplies no tree.
5. **The base is contained in the PR head.** The compare API's merge base of
   the base tip and the PR head is the base tip itself — the PR branch has
   absorbed the base, so the PR run's checkout of `refs/pull/<n>/merge`
   resolved to the head's own tree, and its diff base was older (a superset
   lane selection).
6. **Fail closed on doubt.** Any refused read, malformed field, unknown shape,
   or missing evidence is `reuse=false`, logged with the reason, and the merge
   group runs its gate jobs. Candidate runs are scanned until one satisfies
   every check; an earlier green run with the wrong tree or ancestry does not
   hide a later fully verified run.

Whether reuse is on is committed policy, never a variable (ADR-0181):
`runnerRouting.mergeGroup.reusePrFabric` in `.hobo/ci.json` (the committed
`true` enables it; `false` makes every merge group re-run its gate jobs). It
is read beside the script in the trusted checkout, mirroring
`runnerRouting.mainGate.reuseMergeQueue`. An unreadable file, invalid JSON, or
schema-invalid or incomplete routing policy disables reuse; none falls back
to an implicit enabled default.

### What is skipped, and what still runs

The route job's `pr-fabric-green` output skips exactly the merge-group gate
job set an attestation may also cover (`GATE_JOBS_BY_EVENT.merge_group`):
**PR impact validation**, **Workspace test shards**, and **Scripts tests**.
The `pr-gate` required check accepts those three skipped only when the route
job itself succeeded and reported `pr-fabric-green=true`, the same shape it
uses for an attestation. Everything else is untouched:

- **Secret scan** keeps its own job (pull requests) and the full-history
  betterleaks scan on main; nothing here skips either.
- **Required merge-only checks** — CI runner image (already skipped on
  merge_group by its own inputs logic), CI fabric contract guard, artifact
  signing, hobo dev cold loop — keep their existing conditions.
- **The route job, the gate (`pr-gate`), and finish-side jobs** still run; the
  gate is GitHub-hosted arithmetic over the results.
- **`ci-runner-image` skip logic** is unchanged; reuse does not feed it.

## Expected savings

The 2026-11-20 read-only latency analysis measured the typical merge (the
average of #2019/#2020) at 10.8 minutes enqueue-to-merged, of which the S0
gate set (~1.6 min), the critical shard's setup+build+tests (~5.5 min), and
the scripts lane dominate; skipping the full gate-job set is bounded at about
**8 minutes per matching merge** (ranked mitigation 9's upper bound), leaving
route plus the required checks' gate on the order of 1–2.5 minutes. At the
measured 30% match rate that averages roughly 2.4 minutes off every merge and
returns 1–2 hosted-runner job slots plus the S0/shard runner-minutes on nearly
a third of merges. The 33 base-moved merges stay full-length until PRs are
kept current with the queue's base; that knob is deliberately not part of
this change.

## Verified

- `scripts/test/pr-fabric-reuse.test.ts` — the entry pattern, every refusal
  (policy off, unreadable or invalid policy, non-merge-group, unparseable
  branch, base/event mismatch, wrong PR association, wrong base ref or SHA,
  other tree, base not contained, unfetched evidence), scanning past rejected
  green runs, the evidence fetch's URL shape, and its fail-closed behavior on
  every refused or failing read.
- `scripts/test/attested-jobs.test.ts` — the covered jobs' new conditions
  match the workflow, and the shadow-plan and workflow blob pins were
  re-reviewed for the change (a local run evaluates
  `needs.route.outputs.pr-fabric-green` as `false`, so the local-run
  behaviour is unchanged).
- `scripts/test/runner-routing.test.ts` and
  `packages/ci-gh-actions/test/runner-routing.test.ts` — the new
  `runnerRouting.mergeGroup.reusePrFabric` knob parses identically in the
  dependency-free reader, the zod schema and the CUE constraints, on the
  committed block and every fixture.
- `scripts/test/local-attest.test.ts`, `scripts/test/route-runner.test.ts`,
  `scripts/test/pr-batch-route.test.ts`, `scripts/test/trusted-route.test.ts`,
  `scripts/test/main-gate-finish.test.ts`,
  `scripts/test/ci-fabric-concurrency.test.ts`,
  `scripts/test/ci-runner-image-contract.test.ts`,
  `scripts/test/merge-queue-reuse.test.ts`, `node --import tsx
  scripts/lint-actions.ts`, `pnpm run test:schema`,
  `pnpm --filter @hobo/ci-gh-actions run schema:check`.
- Not verified: no merge group has run with the change on GitHub yet. The
  route step's evidence lookup, the three skipped jobs and the gate's
  acceptance of them have not run for real; the first matching merge should
  log `pr-fabric reuse: yes: a green PR Fabric run tested this tree at this
  base (pr N, run M)` and show the three gate jobs skipped with
  **PR impact gate** green.
