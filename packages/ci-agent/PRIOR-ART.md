# Prior art and parity

How other systems order a merge queue and resolve conflicts with a model, and
where this agent stands against each practice. Sources were read on
2026-11-10. A claim marked *(unverified)* came from a search result or a
secondary page, not the primary source.

## Two findings that shaped the design

**No merge queue resolves conflicts inside the queue.** Mergify, Graphite,
Trunk and Aviator document none. Graphite says so directly: it "can't resolve
any legitimate merge conflicts as a result of racing PRs on trunk". The
resolvers that ship (GitHub Copilot's cloud agent, GitLab Duo) work on the
pull request's own branch and push there, and the result re-enters through
the normal gates. This agent does the same.

**Reordering is only cheap before checks start.** On GitHub, a pull request
that jumps the queue rebuilds every in-progress merge group; Aviator resets
its drafts the same way. Mergify inserts a higher-priority pull request
behind the checks already running unless told otherwise. This agent orders
only entries that have not started.

## Merge queue mechanics

| System | What matters here | Source |
| --- | --- | --- |
| GitHub merge queue | CI runs on `merge_group`, on temporary `gh-readonly-queue/<base>/…` branches. A failure, timeout or base conflict removes the pull request and rebuilds the groups behind it. | [docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) |
| Mergify | Batches fill by priority, then stack, then similarity of changed directories. A pull request that conflicts with one ahead is held in place; if that one merges, it is dequeued as conflicting with the base branch. Stacks need `Depends-On`, and predecessors queue first. Bisection cuts a failed batch into cumulative parts. | [batches](https://docs.mergify.com/merge-queue/batches/), [lifecycle](https://docs.mergify.com/merge-queue/lifecycle/), [stacks](https://docs.mergify.com/merge-queue/stacks/) |
| Graphite | The stack is the atomic unit; a failure evicts the stack and cancels dependents. | [docs](https://graphite.com/docs/merge-queue-optimizations) |
| Aviator | Disjoint affected-target sets become independent queues. | [docs](https://docs.aviator.co/mergequeue/concepts/affected-targets) |
| Trunk | Suggested batches of 4 with a 5-minute wait; halving bisection. | [docs](https://docs.trunk.io/merge-queue/optimizations/batching) |
| Zuul | Each change is tested on top of all changes ahead; the window grows by one per merge and halves on failure. | [docs](https://zuul-ci.org/docs/zuul/latest/gating.html) |
| Uber SubmitQueue | A conflict analyzer plus success-probability model choose which speculative builds to run. Two concurrent, potentially conflicting changes have a 5% chance of a real conflict; sixteen have 40%. | [EuroSys '19](https://lethain.com/static/blog/2019/eurosys19uber.pdf) |
| GitLab merge trains | A merge request that cannot be combined with earlier ones is dropped with a note naming the conflicting files. | [docs](https://docs.gitlab.com/ci/pipelines/merge_trains/) |

## Model-backed conflict resolution

| System | What it does | Source |
| --- | --- | --- |
| GitHub Copilot cloud agent | Resolves conflicts on request, in its own environment; "checks that the build and tests still pass, and pushes". Pushes only to the pull request branch or a `copilot/` branch, cannot approve or merge, and its commits are signed. | [changelog](https://github.blog/changelog/2026-03-26-ask-copilot-to-resolve-merge-conflicts-on-pull-requests/), [risks](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations) |
| GitLab Duo | Edits, commits and pushes to the source branch and posts a summary. Eligible files are UTF-8 text under 200 KB at the same path on both sides. | [docs](https://docs.gitlab.com/user/project/merge_requests/conflicts/) |
| Cursor, JetBrains | Suggest in the editor; a person applies. *(unverified)* | |
| LLMinus (Linux kernel RFC) | Retrieves similar past resolutions, and has a build-fix mode for semantic conflicts. | [LWN](https://lwn.net/Articles/1053714/) |

Reported accuracy is modest. Merge-Bench (7,938 hunks, 11 languages) has the
best models under 60% ([paper](https://arxiv.org/abs/2605.25890)). On
ConflictBench, models match the developer on 55–59% of conflicts against
36.7% for the best classical tool ([paper](https://arxiv.org/abs/2607.27674)).
That paper has two findings this design leans on: classical tools abstain on
20–90% of conflicts, so a model's advantage is mostly coverage; and a model
used as a judge accepted four of five structurally invalid resolutions, "so
structural correctness should not be delegated to an LLM".

Prompt injection through repository text is a demonstrated attack on CI
agents: untrusted pull request text in a prompt plus privileged tools led to
secret exfiltration ([PromptPwnd](https://aikido.dev/blog/promptpwnd-github-actions-ai-agents)).
The mitigations it lists are to restrict tools, keep untrusted text out of
prompts, treat output as untrusted, and limit token scope.

## Parity

Ordered by how much each matters.

| # | Practice | This agent |
| --- | --- | --- |
| 1 | Never write to queue-owned refs; resolve on the pull request branch or a side branch | **Done.** Enforced in the git workspace and tested. |
| 2 | Run the full required CI on the exact resolved tree; model output is never a merge condition | **Done by construction**: the agent never merges. It does not check that the repository has required checks. |
| 3 | Deterministic checks before any model judgement | **Partly.** No leftover markers, and the change is confined to conflict regions by construction. No parse or duplicate-declaration check. |
| 4 | Layered resolution: recorded resolutions, then structured merge, then a model on the residue | **Partly.** Git's own merge (zdiff3, with the common base) runs first and the model sees only the residue. No rerere, no structured merge. |
| 5 | Abstain on ineligible files and protected paths; suggest by default | **Done.** `mode` has no default and `observe` writes nothing. |
| 6 | Prompt-injection posture: only code hunks in the prompt, no tools, short-lived scoped token | **Done.** The queue label is the trigger; applying a label needs triage access. |
| 7 | Provenance: signed commits, an agent trailer, a summary comment, an audit log; cannot approve or merge | **Partly.** Trailers, comment and journal. Commits are unsigned. |
| 8 | Feed build failures on the merged tree back to the model | **Not done.** |
| 9 | Idempotent attempts and spend caps | **Done.** One attempt per pair of commits and policy; per-call, per-pass and per-day limits. There is no per-pull-request cap: each new base commit is a new attempt, bounded by the daily budget. |
| 10 | Reorder only what has not started; respect stacks and priority; age waiting work | **Done.** |
| 11 | Conflict-aware batching from trial merges, with bisection on failure | **Partly.** Trial merges and batching. No bisection: the agent does not read CI results. |
| 12 | Tolerate flaky failures | **Not applicable**: the agent does not act on CI failures. |
| 13 | Adaptive speculation window and success-probability ordering | **Not done.** Only SubmitQueue does this. |
| 14 | Forward-only commits; dequeue and revert after a post-merge failure | **Partly.** Commits are forward-only and never forced. No automatic revert. |
