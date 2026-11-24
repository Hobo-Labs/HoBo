---
name: hobo-ci-route-jobs
description: Use when moving a repository's GitHub Actions jobs onto HoBo CI routing — writing or changing the runnerOrder in .hobo/ci.json, putting jobs on the fleet label, checking the first routed run, or taking it all back out. Five steps in order: plan, review, apply, confirm, undo. Never commits or pushes unless asked; every change is a diff the person reviews.
---

# Route a repository's jobs through HoBo CI

A job is routed by the repository's committed **runner order**
(`runnerOrder` in `.hobo/ci.json`, ADR-0183). Routing happens in HoBo CI, never
in a workflow: the only change a workflow gets is `runs-on` set to a HoBo label,
and HoBo CI routes the job when it claims it. Never add a routing or evaluator
job to a workflow. Routing changes are commits a
team reviews, so this skill only ever produces a diff. Commands are explained
in the `hobo-ci` skill; codes are in `docs/ci/errors.md`.

Work through the steps in order and stop at each "Stop" until the person
answers.

## 1. Plan

1. Read `.hobo/ci.json`. If it has no `runnerOrder`, the default order is
   `fleet`, then `machine`, then `github`.
2. If the person wants a different order, draft the block. Each step appears
   once (`github` may appear twice: once with `minutesLimitPercent`, once
   without). A hosted provider may carry `spendLimitUsd`:

   ```json
   "runnerOrder": {
     "steps": [
       { "key": "machine" },
       { "key": "blacksmith", "spendLimitUsd": 100 },
       { "key": "github", "minutesLimitPercent": 80 },
       { "key": "github" }
     ],
     "retry": { "enabled": true, "runner": "other", "max": 1 },
     "autoSizeVcpus": 4
   }
   ```

3. List the jobs that can move: `hobo ci init --plan --json`. Each job is
   ready, already moved, or skipped with a reason (a job that routes other
   jobs, a job that uses secrets, an environment or an OIDC token).
4. Preview the walk for a typical job, with the labels it would ask each
   runner type for:

   ```sh
   hobo ci route --github ubuntu-24.04 --fleet hobo --json
   hobo ci route --github ubuntu-24.04 --machine self-hosted --public --json
   ```

   Add `--facts facts.json` to see what happens when the fleet is full, a
   machine is paused or a limit is reached. Without it the fleet and machines
   are absent and no limit is measured.

## 2. Review

Show the person, in plain sentences:

- the order as it will be committed, and what each limit means;
- each job that will move, and each that will not and why;
- that a machine never takes a public repository's job or a fork's pull
  request, and the fleet takes them only when it isolates such jobs;
- that a runner type a job does not name is never used for it;
- what happens when nothing fits: HoBo CI records the reason in one sentence
  rather than leaving the job queued for a runner that will never come.

Moving jobs that use secrets needs `--include-secret-jobs`; ask before using
it. **Stop:** apply nothing until the person agrees with the plan.

## 3. Apply

`hobo ci init --apply <jobs>` (job, `file:job` or `all`) rewrites each job's
`runs-on` to the fleet label (`hobo`, or `--fleet-label`) and keeps the old
label in a trailing `# was ...` comment. That is the whole workflow change;
the runner order in `.hobo/ci.json` decides where each job runs.

Then show `git diff` of exactly what changed (`.hobo/ci.json` and the workflow
files). **Stop:** commit, push or open a pull request only when asked, with a
conventional, scoped message such as `ci: route jobs through the runner order`.

## 4. Confirm

After the change is pushed (by the person, or by you when asked):

1. Find the run: `hobo ci list --json`, then
   `hobo ci inspect <run> --wait --json`.
2. `hobo ci activity --json` says where each routed job went and why:
   `runner`, `step`, `outcome` (`routed`, `waiting` or `none`) and `reason`.
3. `waiting` is normal: every runner that fits was busy, and the job queued on
   that runner's label.
4. `none` carries the reason. Read it, fix the order, and push again.
   `hobo ci diagnose <run>` explains any other failure.
5. Report what ran where, with the run's link. A routing change is not
   confirmed until a run shows it.

## 5. Undo

- **Fleet label:** put back the label kept in each rewritten job's trailing
  `# was ...` comment. If nothing was committed yet, `git checkout -- <files>`
  discards the edit; if it was, `git revert` the commit.
- To stop using an order but keep the jobs moved, remove `runnerOrder`; the
  default order applies.

Show the diff and **stop** for the person, as in step 3.
