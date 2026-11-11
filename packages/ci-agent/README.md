# HoBo CI agent

`@hobo/ci-agent` is an optional agent for the [HoBo CI relay](../ci-gh-actions/README.md).
It watches the pull requests waiting to merge, plans the order they should go
in, and resolves merge conflicts with a language model you configure. It is
off unless a repository adds an `agent` block to `.hobo/ci.json`.

The agent never merges anything. A resolution is an ordinary commit, on the
pull request's own branch or on a side branch, and it reaches the base branch
only through the repository's required checks and merge queue. No model output
is ever a merge condition.

**Status.** Everything below is implemented and tested against real git and
the AI SDK's mock model. Nothing here has been run against GitHub or a live
model yet; see [What is not done](#what-is-not-done) before you turn on
`apply`.

## What it does

Each pass (once a minute by default), per connected repository:

1. **Observes the queue.** Entries already in GitHub's merge queue, followed
   by open, non-draft pull requests that carry the queue label (`hobo-queue`
   by default), in the order the label was applied.
2. **Trial-merges** each entry against the base branch, and each pair of
   entries that changed a common path, with `git merge-tree`. Nothing is
   checked out and no ref moves.
3. **Plans the order.** Entries whose checks have started stay where they
   are. A stacked entry follows its parents. An entry that has waited
   `maxWaitMinutes` is taken before any younger one. Within those limits a
   priority label comes first, then the entry that conflicts with the fewest
   others, then the oldest. Entries that merge cleanly together are grouped
   into batches of up to `maxBatchSize`.
4. **Resolves conflicts with the base branch.** For a pull request that no
   longer merges, the configured engine is asked for replacement text for
   each conflict region, and the result is committed as a merge of the base
   branch into the pull request.
5. **Publishes**, as far as its mode allows.

| Mode | Plans and resolves | Pushes | Enqueues |
| --- | --- | --- | --- |
| `observe` | Yes, recorded in its journal only | Nothing | Nothing |
| `suggest` | Yes | The merge commit to `hobo-agent/resolve/<pr>-<sha>`, plus a comment on the pull request. The pull request branch is not touched. | Nothing |
| `apply` | Yes | The merge commit to the pull request's own branch (a fast-forward), plus a comment. A fork's branch is never pushed to; it gets the `suggest` treatment. | Labelled pull requests that merge cleanly, in planned order, up to `maxBatchSize` per pass. A commit is enqueued once: if the queue ejects it, a person re-enqueues it or pushes a new commit |

`apply` acts only when GitHub confirms that the base branch has a branch
protection rule naming at least one required status check. Without that
confirmation (no rule, no named checks, or a failed lookup) the pass behaves
as `suggest`, and records `ci.agent.ApplyWithheld` once a day. Required checks
set only through repository rulesets are not read, so such a branch is
treated as unconfirmed.

With `queue.rollup: true` in `suggest` mode, the agent also merges the first
batch of waiting pull requests together onto `hobo-agent/rollup/<id>`,
resolving conflicts between them, and comments on each. It does not open a
pull request for that branch. Rollup cannot be combined with `apply`.

## Configure it

Add an `agent` block to `.hobo/ci.json` ([example](examples/ci.json)):

```json
{
  "agent": {
    "mode": "suggest",
    "engines": [
      { "id": "primary", "kind": "anthropic", "model": "claude-sonnet-4-5", "credential": "env:ANTHROPIC_API_KEY" },
      { "id": "fallback", "kind": "gateway", "model": "openai/gpt-5.1", "credential": "env:AI_GATEWAY_API_KEY" }
    ]
  }
}
```

`mode` and at least one engine are required. Everything else has a default.

**Engines** are tried in order; a later one is used only when an earlier one
fails to answer. They are built on the [Vercel AI SDK](https://ai-sdk.dev)
(`ai` 7).

| `kind` | `model` | Package loaded |
| --- | --- | --- |
| `gateway` | An AI Gateway id such as `anthropic/claude-sonnet-4.5` | `ai` (bundled) |
| `openai` | An OpenAI model id | `@ai-sdk/openai` |
| `anthropic` | An Anthropic model id | `@ai-sdk/anthropic` |
| `google` | A Google model id | `@ai-sdk/google` |
| `openai-compatible` | Any id; requires an `https` `baseUrl` | `@ai-sdk/openai-compatible` |
| `harness` | `claude-code`, `codex`, `pi`, `opencode` or `grok-build` | None; the host supplies the engine |

The provider packages are optional peer dependencies and are imported only
when an engine names them. `credential` is a reference, `env:NAME` or
`github-secret:NAME`, resolved from the relay process's environment. A key
written into the file is rejected, by this package and by the relay's
project-config parser. A referenced name that is not set stops startup.

**Policy** (all optional):

| Setting | Default | Meaning |
| --- | --- | --- |
| `queue.label` | `hobo-queue` | Label that puts an open pull request in the agent's queue |
| `queue.maxDepth` | 20 | Entries considered per pass |
| `queue.maxBatchSize` | 4 | Entries per batch, and enqueued per pass |
| `queue.maxWaitMinutes` | 240 | After this wait an entry cannot be passed by younger work |
| `queue.priorityLabels` | none | Labels planned first, in the order listed |
| `queue.rollup` | `false` | Publish a combined candidate branch (`suggest` only) |
| `resolution.protectedPaths` | none added | Extra globs the agent never resolves |
| `resolution.maxConflictedFiles` | 5 | More than this abstains |
| `resolution.maxConflictRegions` | 20 | More than this abstains |
| `resolution.maxFileBytes` | 262144 | A larger conflicted file abstains |
| `resolution.minConfidence` | 0.8 | A region answered below this abstains |
| `resolution.contextLines` | 12 | Unconflicted lines shown around each region |
| `budget.maxInputTokens` | 60000 | Estimated prompt size above this abstains |
| `budget.maxOutputTokens` | 8000 | Output limit per file |
| `budget.maxTokensPerDay` | 2000000 | Tokens per UTC day, across repositories |
| `budget.timeoutSeconds` | 120 | Per engine call |
| `budget.maxResolutionsPerTick` | 2 | Model-backed resolutions started per pass |

## Run it with the relay

With an `agent` block in `.hobo/ci.json`, `hobo ci serve` starts the agent
beside the relay. Put each referenced model credential in the environment:

```sh
ANTHROPIC_API_KEY=... hobo ci serve --environment local
```

The agent's journal and clones go under `<HOBO_HOME>/ci/serve/agent`.
`hobo ci serve --no-agent` serves the same project without it.

The container image and other hosts of the Node relay start it through this
package's entry instead of the relay's own:

```sh
HOBO_CI_AGENT_CONFIG=.hobo/ci.json \
HOBO_CI_AGENT_DIR=/var/lib/hobo-ci/agent \
ANTHROPIC_API_KEY=... \
node packages/ci-agent/dist/relay-main.js
```

It reads the relay's usual `HOBO_CI_*` settings. Without
`HOBO_CI_AGENT_CONFIG`, or when that file has no `agent` block, it starts the
relay exactly as the relay's own entry does. `HOBO_CI_AGENT_DIR` holds the
agent's journal (`agent.sqlite`) and one bare clone per repository.
`HOBO_CI_AGENT_INTERVAL_SECONDS` sets the pass interval (60).

The agent runs as a second worker beside the relay's tick. It never delays
job dispatch, one pass runs at a time, a failed pass is logged as
`agent.tick_failed` with no detail, and shutdown waits for a pass in flight.

The relay's GitHub App needs `contents: write` and `pull_requests: write` for
`suggest` and `apply` (the App manifest in `@hobo/ci-gh-actions` already
requests both), and `apply` needs the merge queue enabled on the base branch.
Git reaches GitHub with a short-lived installation token sent as a header on
each fetch and push; it is never written to the clone.

To embed the agent in your own host, build it from parts:

```ts
import { createRelayAgent } from "@hobo/ci-agent/relay";
import { createConfiguredEngines, environmentCredentials } from "@hobo/ci-agent/ai-sdk";
import { parseAgentConfig } from "@hobo/ci-agent/config";

const config = parseAgentConfig(agentBlockJson);
const agent = createRelayAgent({
  config,
  connections,
  token: (installationId) => github.installationToken(installationId),
  stateDirectory: "/var/lib/hobo-ci/agent",
  engines: await createConfiguredEngines(config, { credential: environmentCredentials(process.env) }),
});
createRelayHost({ ...relayOptions, agent });
```

## Guardrails

What the agent will not do, and where that is enforced:

- **It does not merge, approve, or push to the base branch.** It has no code
  path that calls a merge or review API. The workspace refuses any push that
  is not a fast-forward, and refuses branches owned by a merge queue
  (`gh-readonly-queue/`, `mergify/merge-queue/`, `gtmq_`).
- **A model cannot change a line git already merged.** The engine returns
  text for conflict regions only. The file is rebuilt from git's own merge
  output with those regions filled in, so everything outside a region is
  copied through.
- **The engine has no tools.** It is sent conflict text as one JSON document
  and returns structured text. It has no repository access, no network and no
  credentials. Pull request titles, descriptions and comments are never sent.
- **Some paths are never resolved**, whatever a repository configures:
  `.github/**`, `.hobo/**`, `CODEOWNERS`, and package-manager lockfiles. A
  conflict in one hands the whole merge to a person.
- **`apply` needs required checks.** Unreviewed model output only enters a
  pull request branch or the merge queue when the base branch is confirmed to
  require status checks; otherwise the pass only suggests.
- **It abstains rather than guesses.** Binary files, a delete against a
  modify, renames, mode changes, oversized files, too many files or regions,
  an answer below `minConfidence`, and replacement text that contains conflict
  markers or is far larger than the region all end the attempt. A second
  engine is never asked for a more confident answer to the same question.
- **One attempt per merge.** An attempt is keyed by the two commits and the
  policy. Its outcome is journalled, and the same pair is not tried again,
  including after a restart. Reaching the daily budget is the exception: that
  merge is retried the next day. A resolution whose push failed is published
  on a later pass without asking the model again.
- **Budgets hold across calls.** Each file with conflicts is its own model
  call, and an attempt reserves output tokens for every one of them before it
  starts. A fallback engine is only tried while the day's budget still covers
  a full attempt.
- **Reasons are fixed codes.** Journal entries, logs and errors never carry
  model output or repository text.

Each merge commit says in its message that it was written by an agent and has
not been reviewed, and carries `Hobo-Agent-Resolution` and `Hobo-Agent-Engine`
trailers.

## What is not done

- **No live verification.** The GitHub GraphQL queries and mutations are
  written from GitHub's published schema and pinned by a hand-authored Pact.
  They have not been run against GitHub. No live model has been called.
- **Only the Node relay runs the agent**: `hobo ci serve` and this package's
  entry. The Vercel host and the box worker daemon cannot.
- **Harness engines are a port, not an implementation.** A `harness` engine
  needs the host to supply one; `relay-main` supplies none, so a block that
  names a harness stops startup.
- **No check that the resolved code is right beyond CI.** There is no parse
  check, no duplicate-declaration check, and no loop that feeds a failing
  build back to the model. A wrong but plausible resolution is caught by the
  repository's required checks and by review, or not at all.
- **Rulesets are not read.** `apply` recognises required checks from a branch
  protection rule only. A base branch whose checks are required through
  repository rulesets alone is treated as unprotected, and `apply` only
  suggests there. The agent also does not check that the required checks are
  the right ones.
- **Commits are not signed.** A branch that requires signed commits will
  refuse the push.
- **Stacked pull requests are not detected** by the GitHub queue adapter;
  the planner honours dependencies when a queue source supplies them.
- **Nothing reorders entries already in GitHub's merge queue**, by design:
  moving one rebuilds every merge group behind it.
- **No batch bisection.** The agent does not read CI results, so it cannot
  split a failed batch.
- **Peer conflicts wait.** A pull request that conflicts with one ahead of it
  is planned behind it and resolved only after that one merges, when the
  conflict is with the base branch. Rollup is the exception.

[PRIOR-ART.md](PRIOR-ART.md) sets these against what other merge queues and
conflict resolvers do. [ADR.md](ADR.md) records the design decisions.

## Layout

| Path | What |
| --- | --- |
| `src/planner.ts` | The deterministic queue planner |
| `src/conflict.ts` | Conflict-region parsing and file reassembly |
| `src/resolver.ts` | Eligibility, budgets, engine fallback, answer checks |
| `src/agent.ts` | One pass: observe, plan, resolve, publish |
| `src/ai-sdk-engine.ts` | Engines over AI SDK models (`./ai-sdk`) |
| `src/git-workspace.ts` | Trial merge, commit and push with git plumbing (`./git`) |
| `src/github-queue.ts` | GitHub merge queue over GraphQL (`./github`) |
| `src/sqlite-journal.ts` | The durable journal (`./sqlite`) |
| `src/relay.ts`, `src/relay-main.ts` | Composition with the relay (`./relay`) |
| [`data-models/`](data-models/README.md) | Protobuf and CUE for every record |
| [`contracts/`](contracts/README.md) | Pacts for the GitHub and engine boundaries |

## Test it

```sh
pnpm exec turbo run build --filter=@hobo/ci-agent...
pnpm --filter @hobo/ci-agent test
```

The workspace, agent and relay suites create real repositories under the
system temp directory and run real `git` (2.38 or newer). No test uses the
network.
