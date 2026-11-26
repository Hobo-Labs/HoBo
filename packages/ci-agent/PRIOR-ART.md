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
| 2 | Run the full required CI on the exact resolved tree; model output is never a merge condition | **Done by construction**: the agent never merges, and `apply` only acts when the base branch is confirmed to require named status checks, by branch protection or by an active ruleset. |
| 3 | Deterministic checks before any model judgement | **Done.** No leftover markers; the change is confined to conflict regions by construction (only the opt-in structured merge, itself deterministic, settles a whole file); a TypeScript, JavaScript, JSON or YAML file that parsed on both sides must still parse; no new duplicate top-level declarations. Types and tests are left to CI. |
| 4 | Layered resolution: recorded resolutions, then structured merge, then a model on the residue | **Done.** Git's own merge (zdiff3, with the common base) runs first. A region resolved before, in a resolution whose required checks then passed, is reused without a model, as rerere does, keyed by the hash of its three sides. With `resolution.structuredMerge`, mergiraf merges each file by its syntax tree; a clean result that passes the deterministic checks needs no model. The model sees only what is left. |
| 5 | Abstain on ineligible files and protected paths; suggest by default | **Done.** `mode` has no default and `observe` writes nothing. |
| 6 | Prompt-injection posture: only code hunks in the prompt, no tools, short-lived scoped token | **Done.** The queue label is the trigger; applying a label needs triage access. |
| 7 | Provenance: signed commits, an agent trailer, a summary comment, an audit log; cannot approve or merge | **Done.** Trailers, comments and the journal; SSH-signed commits with `commit.signingKey`. GitHub marks them verified only when the key is registered on the account named by `commit.email`. |
| 8 | Feed build failures on the merged tree back to the model | **Done.** A published resolution whose required checks fail is repaired with the earlier answer and the bounded check output (titles, summaries, annotations), up to `maxRepairs` times, then handed to a person. |
| 9 | Idempotent attempts and spend caps | **Done.** One attempt per pair of commits and policy; per-call, per-pass and per-day limits. There is no per-pull-request cap: each new base commit is a new attempt, bounded by the daily budget. |
| 10 | Reorder only what has not started; respect stacks and priority; age waiting work | **Done.** Stacks are read from GitHub: a labelled pull request based on another one's head branch depends on it. |
| 11 | Conflict-aware batching from trial merges, with bisection on failure | **Done, with GitHub doing the split.** Trial merges and batching in the plan; two conflicting pull requests are never queued together. GitHub's queue gives each entry its own cumulative group, so a failure ejects one entry; the agent notices, never re-adds that commit, and batches it alone. |
| 12 | Tolerate flaky failures | **Done.** A failure only of infrastructure (timed out, failed to start, cancelled, a status error) is not repaired and not enqueued; the agent waits for a re-run. A repair that comes back unchanged is not pushed, since it would only re-run the checks; the pull request is told the failure may be flaky or outside the conflict. A flaky test that reports an ordinary failure costs at most `maxRepairs` model calls. |
| 13 | Adaptive speculation window and success-probability ordering | **By design, GitHub's.** GitHub's queue builds each entry's group on those ahead and sets the concurrency; a speculation window of the agent's own would mean running builds outside the repository's CI. The agent orders by conflicts, priority and age instead. Only SubmitQueue does this. |
| 14 | Forward-only commits; dequeue and revert after a post-merge failure | **Done for what the agent writes.** Commits are forward-only and never forced, and an ejected entry is never re-added at the same commit. The agent never writes the base branch, and everything there passed the required checks in a merge group, so it has nothing of its own to revert. |
