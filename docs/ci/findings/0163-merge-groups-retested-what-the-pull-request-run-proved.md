---
type: CI Performance Finding
title: "Finding 163: merge groups retested what the pull request run proved"
description: "A merge group of HoBo CI Fabric selected its S0 gate set, workspace tests and shards from the diff against the merge group's base, which is the whole pull request, so it reran everything the green pull request run had just tested. It now diffs from the pull request merge commit that green run tested, so it tests only what main and earlier group entries changed since then."
tags: [hobo, ci, performance, merge-queue, affected-tests]
---

# Finding 163: merge groups retested what the pull request run proved

## Measurements

- A merge group's "Resolve the merge group base and gate scope" step diffed `github.event.merge_group.base_sha` against the group's head. Main is squash-merged, so that diff is the pull request's whole change on the new base: the same packages, dependents and S0 checks the pull request run had already passed.
- The whole-tree shortcut in `scripts/ci/pr-fabric-reuse.mts` ([finding 156](0156-merge-queue-tree-reuse.md)) skips the gate jobs only when a green pull request run tested a head whose tree equals the group's tree. Once main moves after the pull request's last push, which is the usual case in a busy queue, the trees differ and the group retests the whole change.

## What a green pull request run proves

A `pull_request` run of HoBo CI Fabric tests GitHub's merge commit `refs/pull/N/merge` at run time, the run's `GITHUB_SHA`. Call it P. Its first parent is the main commit the pull request was merged into, and its second parent is the pull request head. The run is green only when the required `PR impact gate` passed for that tree.

The merge group's tree differs from P's tree only by what main and earlier group entries changed since P's first parent. A test whose import closure reaches none of the files in `git diff P HEAD` has the same inputs P's run gave it. That is the assumption the repository already makes when a pull request tests only what it changed against main.

## Fix

- **Record P.** The route job of every `pull_request` run uploads an artifact named `pr-fabric-tested-<P>-<tree of P>` holding `{mergeSha, tree, prHead, base}`. The name carries everything the reader needs, so the merge group lists a run's artifacts and never downloads one. The steps never fail the job.
- **Find P.** In a merge group, after the whole-tree check, the route job's `pr-fabric` step (`decideProvenTreeDelta` in `scripts/ci/pr-fabric-reuse.mts`, from the trusted base checkout) reads the entry's pull request, lists the successful same-repo `pull_request` runs of this workflow for its current head, newest first, and takes the first one with an unexpired record. It reads P through the commits API and accepts it only when P's tree is the recorded tree, P has two parents with the pull request head second, and the compare API shows P's first parent is an ancestor of the merge group's base. The answer is the route job's `proven-base`, `proven-tree`, `proven-run` and `proven-pr` outputs, all empty otherwise. The same `runnerRouting.mergeGroup.reusePrFabric` policy gates it.
- **Base on P.** `scripts/ci/proven-tree.mts` fetches P when the checkout does not hold it, checks P's tree and that P's first parent is in the merge group's base, then checks out a local commit with the group head's tree whose parents are the group head and P. `git merge-base P HEAD` is then P, so every tool that diffs from the merge base of `--base` (`affected-lanes.mts`, `dependent-tests.mts`, `agent:check` and the checks it runs) sees only the changes since P. Without that commit the merge base of P and a squashed group head is P's first parent, and the diff would hold the whole pull request again. The plan job logs `merge group gate: proven-tree delta from <P> (pr N, run R)` and outputs P as `merge_base` and its tree as `merge_tree`. PR impact validation and each workspace shard run the same script before they use the base.
- **Fallback.** Anything missing or doubtful keeps `merge_group.base_sha`: no record, a failed or cancelled run, a head that moved, a tree mismatch, a first parent outside the base, a failed fetch, a failed read. If the plan job proved P but a later job cannot, that job falls back to the merge group's base with the widest scope: PR impact validation runs `check:all`, and a workspace shard runs every suite of its share.

## Expected effect

For a pull request whose last green run was against a main that has since moved by one to three small commits, the group's diff is those commits. Those commits usually reach few packages, so the shard plan drops to one or two shards and the S0 gate set selects only the checks those commits reach. With the main build cache of [finding 162](0162-merge-queue-shards-rebuilt-every-package-one-at-a-time.md), a group then spends its time on runner pickup, checkout and install: about 5 to 7 minutes end to end, under the 10-minute goal.

## Remaining limits

- Main changes that reach many packages, such as a lockfile or root config change, still widen the group as before; the delta only removes the pull request's own share.
- The record lives as long as the artifact, 30 days. A pull request whose last green run is older runs the full merge-group diff.
- A pull request run started before this change records nothing, so its first merge group after this lands uses the old diff.
