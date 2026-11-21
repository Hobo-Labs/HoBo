# Runner-less checks

A relay in relay mode ([ADR-0183](../../../../docs/ci/runner-order.md),
decision F9) completes a job made only of HoBo check steps itself: it passes
or fails the job with annotations, and no runner starts, so no minute is
billed. Relay mode is described in
[`../relay-answer/RELAY-MODE.md`](../relay-answer/RELAY-MODE.md); this folder
holds the `checks` handler it passes to `answerRelayJob`.

**It is built, not proven.** The checks are tested against the GitHub
simulator, and the lint check against a fake sandbox. No check job has been
answered from GitHub's runner service yet. Gauntlet cases C01 and C02
run at T2 in
[`features/hobo-ci-parity/checks.feature`](../../../../features/hobo-ci-parity/checks.feature);
C01's T3 part is owed, and C01 reads `built-not-proven` in
[`docs/ci/parity-scorecard.md`](../../../../docs/ci/parity-scorecard.md) until
it is linked. The T3 run C01 expects: the closing package of the CI parity
work turns relay mode on for this repository alone on the deployed relay, and
a title check job (`hobo-labs/hobo/checks/pr-title`) asked of the relay label
by the scheduled probe
[`.github/workflows/parity-probe.yml`](../../../../.github/workflows/parity-probe.yml)
is completed by that relay with no runner and no billed minute. That probe
run's URL is what gets linked as C01's `t3Run` in
`features/hobo-ci-parity/cases.json`. No such run exists yet. C02 is T2 only.

## Files

| File | What it holds |
| --- | --- |
| [`checks.ts`](checks.ts) | `createRelayChecks`: the handler, the step rules, the title check, the lint check and the `check.completed` event |
| [`config.ts`](config.ts) | `parseRelayChecksConfig`: the strict `checks` block of `.hobo/ci.json` |
| [`lint.ts`](lint.ts) | The five lint tools, the `LintSandbox` port, and how tool output becomes annotations |
| [`source.ts`](source.ts) | `RelayCheckSource` and `GithubRelayCheckSource`: what a check reads of GitHub |
| [`docker-sandbox.ts`](docker-sandbox.ts) | `createDockerLintSandbox`: the lint tools in a fresh container with no network |

## A check job

A check job asks for the relay label and has only check steps:

```yaml
jobs:
  title:
    runs-on: hobo-relay
    steps:
      - uses: hobo-labs/hobo/checks/pr-title@v1
        with:
          types: feat, fix, docs
```

The rules:

- A step is a check step when its `uses:` path ends in `/checks/pr-title` or
  `/checks/lint`. A job with no check step is not a check job: it is routed.
- Every step of a check job must be a check step. A job that mixes in any
  other step fails with a sentence naming the step, because a relay never runs
  a job's other steps.
- A check's `with:` inputs must be literal text. An expression
  (`${{ ... }}`) fails the job: a relay evaluates no expression. The title
  check takes `types`, the lint check `tools`; any other input fails the job.

The job's `outcome` output is `passed` or `failed` and its `reason` output is
one sentence per check.

## The title check

It needs a `pull_request` or `pull_request_target` event, and reads the pull
request named by the run's ref (`refs/pull/<n>/...`). A `pull_request_target`
run runs at the base branch, so its ref names none, and GitHub lists no pull
request on a run whose head is in a fork. For that run the open pull request
is found from the run's head, with
`GET /repos/{repo}/pulls?state=open&head={owner}:{branch}`, keeping the one
whose head is the run's commit. It checks
the title with `checkPullRequestTitle` from `@hobo/ci`. The allowed types are
the step's `types`, else `checks.prTitle.types` in `.hobo/ci.json`, else the
Conventional Commits defaults. A title that breaks the rule fails the job with
an error annotation naming the rule broken and the types allowed.

## The lint check

It is off unless `.hobo/ci.json` sets `"checks": { "lint": true }`; a lint
step in a repository that has not turned it on fails saying so. It runs
`actionlint`, `shellcheck`, `oxlint`, `ruff` and `typos` (or the ones the
step's `tools` names) on the archive of the commit the run tests, each in a
sandbox with no network, five minutes per tool at most. Each tool is asked for
one `file:line:column: message` line per finding.

The whole lint check, the archive read and every tool together, has one time
budget: eight minutes (`LINT_CHECK_BUDGET_MS`). The reason is the job lock. A
relay holds the job from `acquirejob` until it calls `completejob`, and the
runner protocol client renews no job lock (`renewjob`; see
[`../runner-protocol/RUNNER-PROTOCOL.md`](../runner-protocol/RUNNER-PROTOCOL.md)),
on the assumption that a relay answers in seconds. The open-source runner
renews the lock every 60 seconds (`RenewJobRequestAsync` in
`Runner.Listener/JobDispatcher.cs`, at the commit in
`runner-protocol/source.ts`); the service sets how long a lock lasts
(`lockedUntil`), and the runner source does not state it. This package takes
it as about ten minutes after the last renewal, which has not been measured
against GitHub yet. Eight minutes leaves two over for reading `.hobo/ci.json`,
the title check and `completejob`.

Each tool is given the five-minute limit or the time the check has left,
whichever is less. When the budget is spent the check stops waiting, even for
a tool or archive read that never answers: the tool that was running reads
"stopped when the check's time ran out", each tool not started reads "not run:
the check's time ran out", and the `reason` output starts "Lint timed out".
The job then fails and is completed inside its lock. A longer budget needs
`renewjob` in the runner protocol client first.

The job carries one result annotation per tool, then the findings, 50
annotations at most in all, the last saying how many more were left out. The
`reason` output is one summary line.

`createDockerLintSandbox` runs each tool in a fresh container: `--network
none`, a read-only root, no capabilities, an unprivileged user, bounded memory
and processes, nothing from the host mounted. The archive is piped in on
standard input and unpacked into a scratch folder. A tool that overstays is
killed and its container removed. The image must hold the five tools, `sh` and
`tar`; a missing tool is reported as not installed.

This sandbox is new, not one of HoBo's existing ones, and that is a
deviation from asking for "an existing HoBo sandbox". The ones that exist do
not fit a lint run: the isolated worker's Docker driver
(`../isolated-worker/cli-docker-driver.ts`) talks to the Docker socket to
start long-lived runner containers from a just-in-time runner configuration,
and `ci-vercel`'s `IsolatedSandboxDriver` creates a Vercel Sandbox and starts
a runner in it with a JIT config. Both start a runner that takes a job; a lint
run needs one command on an archive with no network and no runner. The lint
sandbox is the `LintSandbox` port, so an adapter over another sandbox can
replace `createDockerLintSandbox` without touching the checks.

## What it reads

`.hobo/ci.json` at the default branch or the pull request's base branch, never
at the commit under test, so a branch cannot loosen its own checks; the run;
the pull request; and, for the lint check only, the commit's archive. The relay
job message carries no token of the job's own, so the archive is read with the
App installation's `contents: read`. GitHub answers the archive request with a
302 to `codeload.github.com`, which `GithubTransport.request` would refuse, so
the archive is read through `RelayArchiveAccess` instead: the API is asked
with redirects left to the caller, the `Location` must be https on
codeload.github.com, and that URL (it carries its own short-lived token) is
read without the installation token, for three minutes at most, counting bytes
as they arrive and stopping past 200 MiB. A job runs each check once, and the
job's annotations stay at 50 with a title step and a lint step together. It
reads no log and no secret. Each of
these reads is an interaction of the hand-authored pact
[`contracts/relay-checks.pact.json`](../../contracts/relay-checks.pact.json),
which `contracts/relay-checks.consumer.test.ts` runs `GithubRelayCheckSource`
against. The codeload download is the one interaction on another host: its
request names `codeload.github.com`, and the test checks it carries no
Authorization header.

## What it reports

Each check job answered is one `check.completed` event (`RelayCheckCompleted`)
to the `completed` callback: repository, run, job, each check's result, the
conclusion, the time and the node. A failure there never changes the answer.
The usage report counts the job as a relay job finished with no billed minute,
from the run's own job facts.

The event is a callback, not a journal record: nothing here writes
`check.completed` to a journal or store, because the route journal's
`defineRunnerRouteEvent` takes only `runner.route.*` events and a new record
type belongs in `packages/ci/data-models`, outside this folder. A durable
`check.completed` record is follow-up work for that package's owner. No test
here yet shows the usage report counting a check job; that rests on the
existing relay job facts.

## Wiring

The relay's host passes the handler as `checks` to `createRelayAnswerer`:

```ts
const checks = createRelayChecks({
	// github = createGithubAppTransport(...): its installationToken reads the archive.
	source: new GithubRelayCheckSource(github, installationFor, {
		installationToken: (id) => github.installationToken(id),
	}),
	sandbox: lintImage ? createDockerLintSandbox({ image: lintImage }) : undefined,
	completed: async (event) => events.emit(event),
	node,
	nowMs: Date.now,
});
```
