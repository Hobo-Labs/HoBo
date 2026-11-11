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

## Commands, events and replay

Commands: observe a queue, plan it, settle a merge, publish a resolution,
publish a rollup, enqueue an entry.

Events (`AgentEvent`): `ci.agent.PlanProposed`, `ci.agent.ResolutionSettled`,
`ci.agent.ResolutionPublished`, `ci.agent.RollupPublished`,
`ci.agent.EntryEnqueued`, `ci.agent.BudgetExhausted`, `ci.agent.ApplyWithheld`.

The agent is the one actor that writes its journal: it takes the commands
above and appends events, and nothing else writes them. The journal is its
event store, an append-only table in one SQLite file with a single writer.

Four projections answer the agent's questions: the resolution recorded for
a key (which makes an attempt happen at most once), whether an event with a
given key exists (a resolution already published, a commit already enqueued),
tokens spent since a time (the daily budget), and the latest event of a type
per repository (the last plan). They are materialized as columns written in the same statement as the
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
consumer-side only. See [contracts](contracts/README.md).

## Dependencies

`ai` is pinned to the version whose `@ai-sdk/provider` matches the provider
packages. An older `ai` with newer provider packages does not typecheck
under `exactOptionalPropertyTypes`, because the two carry different
`LanguageModelV4` declarations. Provider packages are optional peers so a
relay that uses only the gateway installs none of them.
