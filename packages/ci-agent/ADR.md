# CI agent decisions

## The agent is a second worker, not part of the relay's tick

The relay's tick dispatches runners every five seconds. A model call can take
minutes. The agent therefore runs on its own timer inside the relay's Node
service (`agentTick` in `@hobo/ci-gh-actions`), one pass at a time, and its
failures are logged and never fail the relay. `@hobo/ci-gh-actions` only
schedules a `RelayAgent`; it does not depend on this package. This package
depends on the relay, to compose it in `relay-main`.

## The planner is deterministic; only resolution uses a model

Ordering has hard constraints (started entries, stacks, ageing) that must
hold every time, and its inputs are facts git can establish with trial
merges. A model adds nothing there that the constraints would not have to
re-check. The same snapshot, verdicts and policy always produce the same
plan and digest, and the plan is journalled only when the digest changes.

Within the constraints, the entry that conflicts with the fewest other
movable entries goes first. An entry that conflicts with many is then
resolved once, against everything ahead of it, not once per neighbour.

## Resolve on the pull request branch, against the base branch only

A conflict with a pull request ahead in the queue is not resolved while that
one is still unmerged: merging an unmerged neighbour into a pull request
would put its commits in the wrong pull request if the neighbour never lands.
The entry is planned behind its neighbour and resolved when the conflict
becomes one with the base branch. Rollup is the one place peer conflicts are
resolved, on a branch of its own, and it is never applied unattended.

## Apply is conditional on required checks

In apply mode, text no person has read can reach a pull request branch and
the merge queue. The repository's required checks are then the only thing
between it and the base branch, so the agent asks the host whether the base
branch has them and acts only on a confirmed yes. No rule, a rule with no
named checks, and a failed lookup all mean the pass suggests instead, and
`ApplyWithheld` is journalled once a day so an operator can see why. The
lookup is its own query, separate from the queue snapshot, so that a host
that cannot answer it loses only apply, not the pass.

## The model fills regions; it does not edit files

The agent asks git for the merge with `zdiff3` markers of a length no line of
the file can imitate, splits it into settled text and regions, and asks the
engine for text per region. The file is reassembled from git's settled text
and the answers. Confining the change to conflict regions is then a property
of the code, not a check on the model's output.

## Cheapest resolution first

A conflicted file goes through three layers before it is committed, and each
layer only sees what the one before left.

Recorded resolutions come first. A region is identified by the SHA-256 of
its ours, base and theirs text; a resolution records the text it used for
each region (`Resolution.regions`). A region whose identity appears in a
resolution whose required checks then passed (a `ResolutionChecked` success
in the last 90 days) is filled from that record without a model, as git's
rerere does. Only checked resolutions are reused, so an unverified answer is
never copied into a second pull request. A repair reuses nothing: it exists
because the checks rejected what was there.

The structured merge (mergiraf, opt-in with `resolution.structuredMerge`)
comes second. It is deterministic, settles a whole file or nothing, and its
result must pass the same parse and duplicate-name checks as a model's.
Anything it cannot settle falls back to git's regions. It runs in an empty
directory with only `PATH`, so a repository's attributes cannot steer it.
It may change text git had already merged, which is why it is opt-in and why
the commit names each file it merged.

The model comes last, on the regions left.

## Commands, events and replay

Commands: observe a queue, plan it, settle a merge, publish a resolution,
publish a rollup, enqueue an entry.

Events (`AgentEvent`): `ci.agent.PlanProposed`, `ci.agent.ResolutionSettled`,
`ci.agent.ResolutionPublished`, `ci.agent.RollupPublished`,
`ci.agent.EntryEnqueued`, `ci.agent.BudgetExhausted`, `ci.agent.ApplyWithheld`,
`ci.agent.ResolutionChecked`, `ci.agent.EntryEjected`.

The agent is the one actor that writes its journal: it takes the commands
above and appends events, and nothing else writes them. The journal is its
event store, an append-only table in one SQLite file with a single writer.

Six projections answer the agent's questions: the resolution recorded for
a key (which makes an attempt happen at most once), whether an event with a
given key exists (a resolution already published, a commit already enqueued),
tokens spent since a time (the daily budget), the latest event of a type
per repository (the last plan), the latest check result for a resolution,
and the events of a type since a time (resolutions to check, enqueues to
compare against the queue, checked resolutions to reuse). They are materialized as columns written in the same statement as the
event, and can be rebuilt from the event bodies alone. The same file is the
read store; there is no separate one, and there are no snapshots, because
every question is one indexed query over a journal that grows by a few rows
per pull request. The in-memory journal derives the same projections by
scanning its events.

`ResolutionSettled` is written before anything is pushed, so a crash between
the two leaves an attempt recorded and unpublished, never published and
unrecorded. A later pass publishes a resolved attempt that has no
`ResolutionPublished` event, from the journal and without asking a model
again.

`EntryEnqueued` names the commit it enqueued, and the agent never enqueues
that commit again. A pull request the merge queue ejects (its checks failed)
waits for a person or a new commit; re-enqueueing it automatically would run
the same failing checks every few minutes.

The trial-merge cache and the cool-down after a refused enqueue are in memory
only. Losing them on restart costs git work and at most one repeated enqueue
request per waiting entry.

## Repair from the checks, not from a model's opinion

A resolution is only known to be wrong when the repository's required checks
fail on it. The agent reads the check rollup of each commit it published in
the last day. A failure becomes a `ResolutionChecked` event and, while
attempts remain (`maxRepairs`, 1 by default), a repair: the same regions,
the engine's earlier answer recovered from the committed file, and the check
output, which is bounded, stripped of control characters and labelled as
data in the prompt. The repair is a commit on top of the failed one, so the
branch moves forward and keeps the history of both attempts. A pull request
branch someone else has pushed to since is left alone. A repair deferred by
the budget or the per-pass limit is tried again next pass; `ResolutionChecked`
is written only once the outcome is acted on.

Checks that failed only for infrastructure (a check run that timed out,
failed to start, was cancelled or needs action, or a commit status in
`error`) are not a verdict on the code. The agent records nothing, repairs
nothing, does not enqueue, and waits for someone to re-run them. A rollup
with more contexts than one page is never called an infrastructure failure,
since a failure on the next page could be the code's.

A repair that comes back with the same text as the failed resolution is not
pushed: the new commit would differ only in its parent, and serve only as a
re-run of the checks. The pull request is told the failure may be flaky or
outside the conflict, and the agent stops there.

Before any of that, a resolved file must pass deterministic checks: it must
parse when both sides did, and must not declare a top-level name twice where
neither side did. Research on model resolvers found a model used as judge
accepted most structurally invalid resolutions, so structure is checked by a
parser, not by a model.

## Ejection is the agent's bisection

GitHub's merge queue gives each entry its own cumulative merge group, so a
failing group already points at one entry and ejects it. The agent records
`EntryEjected` when a pull request it enqueued at a commit is waiting again
at that commit, comments once, never enqueues that commit again, and batches
the entry alone in its plan. It also never queues two pull requests whose
trial merge conflicts, since their groups could not both be built.

## An operator sees why an engine did not answer

The resolver hides engine errors from journals and comments, since their
text can carry the request. That left an unpaid account, a revoked key and a
timeout all reported as `engine-unavailable`. Each failure is now in the tick
report as the engine id, a fixed reason and the HTTP status, and the daemon
and the relay log it as `agent.engine_failed`.

## The agent runs on its own as well as inside the relay

The relay host owns its store with one writer, so the agent does not open
it. Run on its own (`daemon-main`), it takes the repositories to watch from
its settings and finds each one's App installation itself. That is how it
runs beside the box worker daemon or a relay on Vercel, whose Functions have
no `git`.

## Signatures in-process

Commits are signed in the SSH signature format with ed25519, written as
commit objects with a `gpgsig` header, without `ssh-keygen` or `gpg` on the
host. Ed25519 signatures are deterministic, which keeps signed merge commits
content-addressed.

## Merge commits are content-addressed

A merge commit is dated by its newer parent, not by the clock, and written by
a fixed identity, so the same merge always has the same commit id. Attempts
are keyed by commit ids. With clock dates, a combined candidate built on a
fresh merge commit would have a new id every pass, and a conflict that the
model declined would be sent to it again every minute until the daily budget
ran out. Each commit the agent writes is kept reachable under
`refs/hobo-agent/commits/`, and what it fetches under
`refs/hobo-agent/fetched/`, so garbage collection cannot remove a resolution
waiting to be published and the next fetch only transfers what is new.

## Contracts

Records are generated from `data-models/agent.proto`, with a CUE definition
for every message in `data-models/agent.cue`.

Parse, don't validate: authored and observed input crosses one parser and
becomes a derived type. `parseAgentConfig` returns a frozen
`ParsedAgentConfig` with every default applied, and `observeQueue` returns an
`ObservedQueue` whose entries are unique, well-formed and in provider order.
Both are brands over the generated records, and the planner, resolver and
agent accept only those parsed types. Zod parses GitHub's GraphQL responses
and the model's structured output once, at the edge.

Pacts cover the GitHub GraphQL boundary and the engine port; both are
consumer-side only. Every GraphQL operation is also validated against
GitHub's published schema, vendored in `contracts/`, so a field GitHub
renames or removes fails a test here. See [contracts](contracts/README.md).

## Dependencies

`ai` is pinned to the version whose `@ai-sdk/provider` matches the provider
packages. An older `ai` with newer provider packages does not typecheck
under `exactOptionalPropertyTypes`, because the two carry different
`LanguageModelV4` declarations. Provider packages are optional peers so a
relay that uses only the gateway installs none of them.
