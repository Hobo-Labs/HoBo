# HoBo CI agent

`@hobo/ci-agent` is an optional agent for the [HoBo CI relay](../ci-gh-actions/README.md).
It watches the pull requests waiting to merge, plans the order they should go
in, and resolves merge conflicts with a language model you configure. It is
off unless a repository adds an `agent` block to `.hobo/ci.json`.

The agent never merges anything. A resolution is an ordinary commit, on the
pull request's own branch or on a side branch, and it reaches the base branch
only through the repository's required checks and merge queue. No model output
is ever a merge condition.

Start a repository in `observe` or `suggest`, and check a real installation
with [`acceptance:live`](#run-it-on-its-own) before you turn on `apply`.
[How it is verified](#how-it-is-verified) lists what each suite covers.

## What it does

Each pass (once a minute by default), per connected repository:

1. **Observes the queue.** Entries already in GitHub's merge queue, followed
   by open, non-draft pull requests that carry the queue label (`hobo-queue`
   by default), in the order the label was applied. A labelled pull request
   based on another one's head branch is part of a stack and depends on it.
2. **Trial-merges** each entry against the base branch, and each pair of
   entries that changed a common path, with `git merge-tree`. Nothing is
   checked out and no ref moves.
3. **Plans the order.** Entries whose checks have started stay where they
   are. A stacked entry follows its parents. An entry that has waited
   `maxWaitMinutes` is taken before any younger one. Within those limits a
   priority label comes first, then the entry that conflicts with the fewest
   others, then the oldest. Entries that merge cleanly together are grouped
   into batches of up to `maxBatchSize`. An entry the merge queue ejected at
   its current commit is batched alone.
4. **Resolves conflicts with the base branch.** For a pull request that no
   longer merges, each conflicted file goes through three layers, cheapest
   first: a region resolved before, in a resolution whose required checks
   then passed, is reused as git's rerere would; with
   `resolution.structuredMerge`, [mergiraf](https://mergiraf.org) merges the
   file by its syntax; and the configured engine is asked for replacement
   text for each region that is left. The result is committed as a merge of
   the base branch into the pull request. The resolved file must still parse
   and must not declare a name twice before it is committed.
5. **Publishes**, as far as its mode allows.
6. **Reads the checks on what it published.** When the required checks fail
   on a resolution, the engine is asked once more (by default) with its
   earlier answer and what the checks reported, and the correction is pushed
   on top. Past that, or when the engine keeps its answer, it tells the pull
   request to resolve the conflict by hand. Checks that failed only for
   infrastructure (a timeout, a runner that did not start, a cancelled run,
   a status error) are not the code's fault: the agent waits for a re-run.
   In `apply`, a pull request whose head is the agent's commit is enqueued
   only once the checks pass on it.

| Mode | Plans and resolves | Pushes | Enqueues |
| --- | --- | --- | --- |
| `observe` | Yes, recorded in its journal only | Nothing | Nothing |
| `suggest` | Yes | The merge commit to `hobo-agent/resolve/<pr>-<sha>`, plus a comment on the pull request. The pull request branch is not touched. | Nothing |
| `apply` | Yes | The merge commit to the pull request's own branch (a fast-forward), plus a comment. A fork's branch is never pushed to; it gets the `suggest` treatment. | Labelled pull requests that merge cleanly, in planned order, up to `maxBatchSize` per pass. A commit is enqueued once: if the queue ejects it, a person re-enqueues it or pushes a new commit |

`apply` acts only when GitHub confirms that the base branch requires at least
one named status check, through a branch protection rule or an active
repository or organization ruleset. Without that confirmation (no rule, no
named checks, or a failed lookup) the pass behaves as `suggest`, and records
`ci.agent.ApplyWithheld` once a day.

In `apply`, two pull requests that conflict are never in the queue together:
the second waits until the first merges, then conflicts with the base branch
and is resolved there. A stacked pull request is neither resolved nor
enqueued until GitHub retargets it to the base branch.

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
| `harness` | `claude-code`, `codex`, `pi`, `opencode` or `grok-build` | `@ai-sdk/harness`, `@ai-sdk/sandbox-just-bash` and the runtime's adapter, such as `@ai-sdk/harness-claude-code` |

The provider packages are optional peer dependencies and are imported only
when an engine names them. A `harness` engine runs a coding-agent runtime
through the AI SDK harness agent with all of the runtime's built-in tools
switched off and an empty in-memory sandbox, so it sees the conflict text
and nothing else, like a model engine. The runtime must be installed on the
host and signs in on its own (Claude Code with `ANTHROPIC_API_KEY`, for
example); a harness entry takes no `credential`. `credential` is a reference, `env:NAME` or
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
| `resolution.maxRepairs` | 1 | Corrected resolutions after the required checks fail on one (0 to 3) |
| `resolution.structuredMerge` | `false` | Try mergiraf on each conflicted file before any engine ([below](#structured-merge)) |
| `commit.name`, `commit.email` | `hobo-ci-agent`, `hobo-ci-agent@users.noreply.github.com` | Author and committer of the agent's commits |
| `commit.signingKey` | none | A reference (`env:NAME`) to an unencrypted ed25519 key that signs every commit |
| `budget.maxInputTokens` | 60000 | Estimated prompt size above this abstains |
| `budget.maxOutputTokens` | 8000 | Output limit per file |
| `budget.maxTokensPerDay` | 2000000 | Tokens per UTC day, across repositories |
| `budget.timeoutSeconds` | 120 | Per engine call |
| `budget.maxResolutionsPerTick` | 2 | Model-backed resolutions started per pass |

## Structured merge

With `resolution.structuredMerge: true`, each conflicted file is first given
to [mergiraf](https://mergiraf.org) (0.20 or newer), which merges by syntax
tree for the languages it supports. A file it merges with no conflict left,
within the size bounds, and that passes the same parse and duplicate-name
checks, needs no model; anything else falls back to git's regions and the
engine. Install `mergiraf` on the agent's host; the agent checks for it at
start-up and refuses to start without it. It runs in an empty directory with
only `PATH` set, so it reads no repository settings and keeps nothing between
merges. A repair never uses it: a repair corrects the regions the checks
rejected.

A structured merge settles the whole file, so its text can differ from
git's merge outside the conflict regions too. The commit message says which
files it merged and names it in the `Hobo-Agent-Engine` trailer.

## Sign its commits

With `commit.signingKey`, every commit the agent writes carries an SSH
signature, so a branch that requires signed commits accepts its pushes. The
key is an unencrypted ed25519 key, PKCS#8 PEM (`openssl genpkey -algorithm
ed25519`) or OpenSSH (`ssh-keygen -t ed25519 -N ""`), in the environment
variable the reference names. Ed25519 signatures are deterministic, so a
signed merge keeps the same commit id from pass to pass.

GitHub shows a commit as verified when the public key is registered as an SSH
signing key on the account whose email is `commit.email`. A GitHub App's bot
account cannot hold one, so use a machine user's email and key.

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
job dispatch, one pass runs at a time, and shutdown waits for a pass in
flight. Each repository's pass is logged as `agent.pass` (counts only), each
engine that gave no answer as `agent.engine_failed` with the engine id, a
fixed reason (`http`, `timeout`, `malformed-answer`, `error`) and the HTTP
status (402 for an unpaid account, 401 for a bad key), and a failed pass as
`agent.tick_failed`. No log entry carries repository or model text.

The relay's GitHub App needs `contents: write` and `pull_requests: write` for
`suggest` and `apply` (the App manifest in `@hobo/ci-gh-actions` already
requests both), and `apply` needs the merge queue enabled on the base branch.
Git reaches GitHub with a short-lived installation token sent as a header on
each fetch and push; it is never written to the clone.

## Run it on its own

The agent also runs as a process of its own, beside any relay host: the box
worker, a container, or a machine next to a relay on Vercel. Vercel
Functions cannot host it, since the agent needs `git` and a disk. It needs
the GitHub App's credentials and the repositories to watch, not the relay's
store:

```sh
HOBO_CI_AGENT_CONFIG=.hobo/ci.json \
HOBO_CI_AGENT_DIR=/var/lib/hobo-ci/agent \
HOBO_CI_AGENT_REPOSITORIES=acme/api,acme/web \
HOBO_CI_GITHUB_APP_ID=123456 \
HOBO_CI_GITHUB_APP_KEY_FILE=/run/secrets/app.pem \
ANTHROPIC_API_KEY=... \
pnpm --filter @hobo/ci-agent agent
```

It looks up each repository's App installation, skips one the App is not
installed on, and drains a pass in flight on SIGTERM.

To check a real installation before trusting it, run one pass and exit:
`pnpm --filter @hobo/ci-agent acceptance:live` with the same settings and
`mode: "observe"`. It reads the queue and plans it, writes nothing to
GitHub, and exits non-zero if the pass fails.

## Embed it

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
  copied through. Only the opt-in structured merge, which is deterministic,
  settles a whole file.
- **The engine has no tools.** It is sent conflict text as one JSON document
  and returns structured text. It has no repository access, no network and no
  credentials. Pull request titles, descriptions and comments are never sent.
- **Some paths are never resolved**, whatever a repository configures:
  `.github/**`, `.hobo/**`, `CODEOWNERS`, and package-manager lockfiles. A
  conflict in one hands the whole merge to a person.
- **`apply` needs required checks.** Unreviewed model output only enters a
  pull request branch or the merge queue when the base branch is confirmed to
  require status checks; otherwise the pass only suggests.
- **A resolved file must still be well-formed.** A TypeScript, JavaScript,
  JSON or YAML file that parsed on both sides must parse after resolution,
  and a script must not declare a top-level name twice where neither side
  did. Otherwise the merge abstains. These are deterministic checks: a
  resolution that passes them can still be wrong.
- **A failed resolution is repaired at most `maxRepairs` times.** Check
  output reaches the engine as data, bounded and stripped of control
  characters, beside its earlier answer. A pull request branch someone else
  has pushed to since is never repaired.
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

## Design decisions

- **Entries already in GitHub's merge queue are never reordered.** Moving
  one rebuilds every merge group behind it.
- **Peer conflicts wait.** A pull request that conflicts with one ahead of it
  is not queued with it; it is resolved against the base branch once that one
  merges. Rollup is the exception, on a branch of its own.
- **Batches are split by GitHub, not by the agent.** Each entry in GitHub's
  merge queue gets its own cumulative merge group, so a failure is attributed
  to one entry and ejects it. The agent's part is to notice the ejection,
  never re-add that commit, and batch the entry alone in its plan.
- **Speculation is GitHub's.** GitHub builds each entry's merge group on top
  of those ahead and sizes the concurrency. An adaptive window or a
  success-probability ordering, as in Uber's SubmitQueue, would need the
  agent to run builds itself. The agent orders by conflicts, priority and
  age, and never queues two entries that conflict.
- **No automatic revert.** The agent never writes the base branch, and every
  commit there passed the required checks in a merge group. A failure after
  merge is a gap in those checks, for a person to fix.
- **The required checks are the verification.** The agent's own checks are
  structural: parsing and duplicate names, not types or tests. `apply`
  confirms that the base branch requires at least one named check; whether
  those checks cover a change is the repository owner's decision.
- **A repair sees check summaries, not full logs.** Check-run titles,
  summaries and annotations are bounded and come with the same GraphQL
  query. Full logs would need another permission, can hold secrets a job
  printed, and put far more untrusted text in front of a model.

[PRIOR-ART.md](PRIOR-ART.md) sets these against what other merge queues and
conflict resolvers do. [ADR.md](ADR.md) records the design decisions.

## Layout

| Path | What |
| --- | --- |
| `src/planner.ts` | The deterministic queue planner |
| `src/conflict.ts` | Conflict-region parsing and file reassembly |
| `src/resolver.ts` | Eligibility, recorded resolutions, budgets, engine fallback, answer checks |
| `src/structured-merge.ts` | mergiraf as the structured merge |
| `src/agent.ts` | One pass: observe, plan, resolve, publish |
| `src/ai-sdk-engine.ts` | Engines over AI SDK models (`./ai-sdk`) |
| `src/harness-engine.ts` | Engines over coding-agent runtimes |
| `src/verify.ts` | Parse and duplicate-declaration checks of a resolved file |
| `src/signing.ts` | SSH commit signatures |
| `src/git-workspace.ts` | Trial merge, commit and push with git plumbing (`./git`) |
| `src/github-queue.ts` | GitHub merge queue over GraphQL (`./github`) |
| `src/sqlite-journal.ts` | The durable journal (`./sqlite`) |
| `src/relay.ts`, `src/relay-main.ts` | Composition with the relay (`./relay`) |
| `src/daemon-main.ts` | The agent on its own (`./daemon`) |
| [`data-models/`](data-models/README.md) | Protobuf and CUE for every record |
| [`contracts/`](contracts/README.md) | Pacts for the GitHub and engine boundaries |

## How it is verified

| Suite | What it covers |
| --- | --- |
| `test/` | The planner, resolver, verification and journal as units; the workspace, agent, relay, daemon and signing suites against real `git` repositories under the system temp directory, with scripted engines and a scripted `mergiraf` |
| `contracts/github-schema.test.ts` | Every GraphQL operation the agent sends, validated against GitHub's published schema (vendored in `contracts/github-schema.graphql.gz`; `pnpm contracts:github-schema` refreshes it) |
| `contracts/*.consumer.test.ts` | The GitHub adapter and the engine prompt against their Pacts |
| `test/ai-sdk-engine.test.ts`, `test/harness-engine.test.ts` | The engines over the AI SDK's mock model and harness |
| `acceptance/` (`test:live`) | One pass with a real model through the AI Gateway, against real `git`; needs `AI_GATEWAY_API_KEY`, and `HOBO_CI_AGENT_LIVE_MODEL` picks the model |
| `acceptance:live` | One `observe` pass against a real GitHub installation |

## Test it

```sh
pnpm exec turbo run build --filter=@hobo/ci-agent...
pnpm --filter @hobo/ci-agent test
```

The suites need `git` 2.38 or newer. `test` uses no network; `test:live`
calls the model:

```sh
AI_GATEWAY_API_KEY=... pnpm --filter @hobo/ci-agent test:live
```
