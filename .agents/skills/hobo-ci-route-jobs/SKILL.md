---
name: hobo-ci-route-jobs
description: Use when moving a repository's GitHub Actions jobs onto HoBo CI routing — writing or changing the runnerOrder in .hobo/ci.json, putting jobs on the fleet label or behind a relay job, checking the first routed run, or taking it all back out. Five steps in order: plan, review, apply, confirm, undo. Never commits or pushes unless asked; every change is a diff the person reviews.
---

# Route a repository's jobs through HoBo CI

A job is routed by the repository's committed **runner order**
(`runnerOrder` in `.hobo/ci.json`, ADR-0183). Routing changes are commits a
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
- what happens when nothing fits: the relay job fails with one sentence and
  the job behind it is skipped, rather than queued for a runner that will
  never come.

Moving jobs that use secrets needs `--include-secret-jobs`; ask before using
it. **Stop:** apply nothing until the person agrees with the plan.

## 3. Apply

Pick the form the CLI the person runs supports (check `hobo ci init --help`):

- **Fleet label (available now):** `hobo ci init --apply <jobs>` (job,
  `file:job` or `all`) rewrites each job's `runs-on` to the fleet label
  (`hobo`, or `--fleet-label`) and keeps the old label in a trailing `# was ...` comment.
- **Relay job (arriving):** `hobo ci init --relay` (job mode, the default)
  or `hobo ci init --relay relay` adds a `relay-<job>` job in front of each
  moved job. It calls `./.github/workflows/hobo-relay.yml` with the job's old
  label as its `github` input, adds itself to the job's `needs`, and sets
  `runs-on: ${{ needs.relay-<job>.outputs.runner }}`. A matrix job gets one
  relay for all its legs. It also writes `.github/workflows/hobo-relay.yml`
  and `.hobo-ci/relay.mjs` (the job-mode evaluator); `--check` says when
  those are stale. In relay mode the relay job asks for the label
  `hobo-relay` and a connected relay answers it; that needs
  `relayJobs.answer: true` in `.hobo/ci.json`.

Then show `git diff` of exactly what changed (`.hobo/ci.json` and the workflow
files). **Stop:** commit, push or open a pull request only when asked, with a
conventional, scoped message such as `ci: route jobs through the runner order`.

## 4. Confirm

After the change is pushed (by the person, or by you when asked):

1. Find the run: `hobo ci list --json`, then
   `hobo ci inspect <run> --wait --json`.
2. A relay job's outputs say where the job went: `runner`, `step`,
   `outcome` (`routed`, `waiting` or `none`) and `reason`. In job mode its
   log holds one `hobo-ci-relay` notice with the whole decision.
3. `waiting` is normal: every runner that fits was busy, and the job queued on
   that runner's label.
4. `none` fails the relay job with the reason as an error annotation. Read it,
   fix the order or the job's inputs, and push again. `hobo ci diagnose <run>`
   explains any other failure.
5. Report what ran where, with the run's link. A routing change is not
   confirmed until a run shows it.

## 5. Undo

- **Relay job (arriving):** `hobo ci init --undo` removes each relay job and
  its `needs` entry and restores the label from the relay's `github` input. It
  refuses a file edited since in a way it cannot reverse, and names the lines.
- **Fleet label:** put back the label kept in each rewritten job's trailing
  `# was ...` comment. If nothing was committed yet, `git checkout -- <files>`
  discards the edit; if it was, `git revert` the commit.
- To stop using an order but keep the jobs moved, remove `runnerOrder`; the
  default order applies.

Show the diff and **stop** for the person, as in step 3.
