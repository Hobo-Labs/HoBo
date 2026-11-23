---
type: Competitive Reference
title: "RelayRunner — Competitor Reference"
description: "A hosted gateway that sends each GitHub Actions job to the first runner in an ordered list that can take it: a teammate's connected machine, an existing self-hosted runner, a hosted provider, or GitHub-hosted. The closest shipped product to HoBo CI's relay, with a generated parity scorecard."
tags: [hobo, competitors]
competitor:
  slug: relayrunner
  name: "RelayRunner"
  aliases: ["relay-runner"]
  primary_category: delivery-release-gitops
  categories: [delivery-release-gitops, finops-governance-placement]
  directness: direct
  role: "the hosted runner router HoBo CI's relay competes with head-on: ordered runner preference, one-command machine enrollment and a relay job the gateway answers itself"
  posture: [displace, borrow, benchmark]
  hobo_surface: [delivery, finops, provider-matching, observability, agent-surface]
  evidence: mixed
  status: active
  research_date: 2026-11-16
  sources:
    - https://github.com/relayrunner/relayrunner
    - https://relayrunner.app/docs
    - https://relayrunner.app/docs/concepts/routing
    - https://relayrunner.app/docs/reference/relay-inputs
---

# RelayRunner — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-11-16**, read for HoBo CI from the public repository at commit
> `43b7c4c` (Apache-2.0): the product docs under `apps/site`, the routing, retry and
> provider-health code under `apps/api`, the shared packages and the CLI. Nothing was run
> against the hosted service. Read alongside [CI fleet balancing](../design/ci-fleet-balancing.md),
> [routing slips](../design/adr/routing-slips.md) and the
> [runner order](../../packages/ci/RUNNER-ORDER.md).

## What it is

RelayRunner is a **hosted gateway for GitHub Actions**. A job opts in by putting a `relay`
job in front of itself and taking its `runs-on` from the relay's output. The gateway walks
the workspace's **runner order** and answers with the label of the first runner that can take
the job now.

- **Product boundary.** It decides where a job runs. It does not run jobs: code, secrets and
  logs stay between GitHub and the runner. It also reports on CI (waits, flaky jobs, cost).
- **Operating model.** A hosted service on Cloudflare Workers; the CLI is on npm. The
  repository is open source, and self-hosting is not a supported path.
- **The differentiator is the relay job.** The gateway registers its own one-job runner,
  claims the relay job over the Actions runner protocol and completes it without a machine,
  so a routing decision takes about a second and bills no minutes.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Workspace** | One GitHub App installation (an organization or a personal account); members come from GitHub |
| **Runner order** | The workspace's ordered list of runner types: `machine`, `github`, and hosted providers |
| **Relay job** | A reusable-workflow job with one input per runner type the job may use, and a `runner` output |
| **Pick runner** | The gateway's own single-use runner that claims the relay job and answers it |
| **Machine** | A computer signed in with `relayrunner connect`; each job gets a fresh one-job runner on it |
| **Adopted runner** | A self-hosted runner an organization already had, routed to by a label the gateway adds |
| **Optimized check** | A check the gateway answers itself: a pull request title check, linters in a sandbox |
| **Signal** | A named pattern of wasted CI time or money found in the run history |

The mental model is **an ordered fallback list with the runners you already own at the top**:
machines add capacity, hosted runners stay the fallback, and nothing waits on a runner that
will never come.

## Feature surface

- **Routing.** Ordered walk with a recorded reason for every step passed over; a job only
  uses runner types its relay named; public repositories never run on machines; `auto`
  inputs resolve to a provider's label for a size (2 to 32 vCPU).
- **Conditions.** GitHub-hosted "while under N% of included minutes", with a two-hour
  runway; hosted providers "while under $X this month" at list prices.
- **Queue or fail.** A job waits only when the machines that fit are busy; in every other
  case the relay fails with the reason.
- **Provider health.** A hosted runner type that misses three jobs in thirty minutes is
  skipped, then retried with back-off.
- **Automatic retries.** A job that failed before its own steps ran, or whose runner was
  lost, is re-run on the same, another or any runner, at most twice per run.
- **Machines.** Device-flow sign-in, slots, pause, sharing (`only_me` or `anyone`), rotating
  tokens, a per-job Linux VM on Apple silicon, and a macOS menu bar app.
- **Hosted providers.** Blacksmith, Depot, Namespace, WarpBuild, Ubicloud, Boat and RunsOn by
  label; usage sync for three of them.
- **Checks without a runner.** A Conventional Commits title check; linters in a sandbox, in
  preview; both configurable from a `relayrunner.yml` in the repository.
- **Insights.** Activity with "show why", run history, per-runner performance, nine signals,
  failed-job diagnosis with a re-run outlook (the classifier is operator-gated),
  OpenTelemetry traces per run.
- **Surfaces.** A dashboard, a CLI with `init` to rewrite workflows, a read-only MCP server,
  three agent skills, a read API, an error catalog.

## Architecture

- A webhooks Worker verifies GitHub deliveries and queues them; an API Worker consumes the
  queue.
- One Durable Object per relay job (the pick runner) speaks the runner protocol to GitHub;
  one per workspace (the router) walks the order and holds the wait line; one per machine
  holds its WebSocket.
- State is in D1; the dashboard is a single-page app; the MCP server is a separate Worker.
- A machine runs the official runner program per job from a just-in-time configuration the
  gateway mints on the job's repository.

## How it competes with HoBo

RelayRunner competes with HoBo CI's relay on the same question, "which runner takes this
job", and reaches a different answer on where the decision lives.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `delivery` | **The real overlap.** Both put a relay between a GitHub Actions job and a runner and register single-use runners. |
| `finops` | Both route by a written order with minutes and spend limits; HoBo also reserves budget per job in a ledger, and its spend limit reads that ledger first. |
| `provider-matching` | Both name the same seven hosted runner providers by label and route to them; HoBo's labels and prices carry a source and a date. |
| `observability` | Both have a dashboard of runners, routing, history, performance and signals; HoBo's is read-only and also has a route journal, traces and CLI reports. |
| `agent-surface` | Both ship a read-only MCP server, setup skills and a workflow-rewriting `init`. |

## Primitive mapping

Refreshed 2026-11-17, after the relay job, machines, checks and the dashboard were built
([ADR-0183](../ci/runner-order.md#adr-0183)).

| RelayRunner | HoBo CI | Honest correspondence |
| ----------- | ------- | --------------------- |
| Runner order | `RunnerOrder` in `@hobo/ci`, committed as `runnerOrder` in `.hobo/ci.json` | **Close in rules, different in home.** The same walk, limits, health and retry rules, plus a `fleet` step RelayRunner has no equivalent of. HoBo's order is committed configuration; a change is a pull request. |
| Relay job | `.github/workflows/hobo-relay.yml`, written by `hobo ci init --relay` | **Close, with two modes.** In job mode a vendored evaluator answers on a GitHub-hosted runner and needs no service. In relay mode a HoBo node answers a job labelled `hobo-relay`. One relay output may feed a matrix. |
| Pick runner | Relay mode: a one-job runner a HoBo node registers and completes over the runner protocol | **Built, not proven.** It runs against the GitHub simulator and ships off (`relayJobs.answer` is false unless written); no production run is linked. |
| Connected machine | `hobo ci machine connect`, with `pause`, `resume`, `share` and `remove` | **Close.** One job per fresh container by default, slots, signed adverts; Linux and macOS (`--host` or `--vm`). Run against the simulator only. |
| Adopted runner | `adoptRunner` in `@hobo/ci-gh-actions` | **Library only.** It adds one label through GitHub's runner-labels API; the `hobo ci runners` command that would call it is not wired. |
| Hosted provider label | Runner-order catalog with dated labels and list prices | **Close.** Seven providers by label; RunsOn carries a reason instead of a price. |
| Minutes and spend limits | `GithubMinutesReader` (billing usage), `LedgerSpendReader` (the ledger, then list prices) | **Close, different source.** Spend is summed from what HoBo reserved and settled; unmeasured values never block. |
| Provider health | `ProviderHealthStore` in SQLite, `hobo ci provider-health` | **Same rule.** Fed from the job's queue in job mode and from webhooks in relay mode. |
| Automatic retry | `auto-retry.ts` on `workflow_run` completed, `hobo ci rerun --reroute` | **Same rule**, with the journal row written before GitHub is asked. Only where a relay with a journal runs. |
| Optimized checks | Runner-less `pr-title` and `lint` check steps in relay mode | **Close.** Lint runs in a container with no network. Relay mode only. |
| Signals, performance, diagnosis | `@hobo/ci/insights`, `hobo ci signals`, `diagnose`, `activity`, `usage`, `performance` | **Close.** Stored in the relay's journal and history; diagnosis has no model. |
| Dashboard | `@hobo/ci-dashboard`, served by the relay over the read API | **Close, read-only.** Five views; "edit" opens a pull request. |
| Read API, MCP server | `/v1/accounts/self/...` with an OpenAPI file; eight read-only MCP tools | **Same surface**, read scope only. |
| Workspace, roles | Account, installation, scoped bearer tokens | **Different.** HoBo has tenants and token scopes, no human roles. |

## Parity scorecard

The parity ledger that was here is replaced by the generated
[parity scorecard](../ci/parity-scorecard.md): 58 cases, one per thing RelayRunner says it
does, each with HoBo's bar, a tier and the state its scenario reached in the last run. The
page is written by `scripts/ci/parity-scorecard.mts` from the case catalog and the
scenarios under [`features/hobo-ci-parity`](../../features/hobo-ci-parity/README.md), and
`--check` fails when it is stale.

On 2026-11-17 the scorecard shows 26 `pass`, 3 `built-not-proven`, 19 `partial`, 9
`not-built` and 1 `met-differently` (S08: no human roles; access is GitHub membership plus
scoped tokens). The 31 cases that are neither `pass` nor `met-differently` are owed. Each
is listed below with the run that would prove it.

### Owed production runs (T3)

A T3 case needs a run in production. None of these was made from the build session,
because each changes production state or needs a workflow on the default branch.

| Case | Built | The run that would prove it |
| ---- | ----- | --------------------------- |
| R01 | Relay mode answers in the simulator | Turn `relayJobs.answer` on for this repository alone on the deployed relay, push a workflow whose relay job asks for `hobo-relay`, and link the run: the relay job completed, no billed minute, the job behind it on the named runner |
| C01 | The `pr-title` check step in relay mode | The same relay-mode setup, with a pull request whose title breaks the rule: the check job fails with the annotation and no runner ran it |
| R04 | The relay job fails with the reason as an annotation and the job behind it is skipped, in job mode (package test) and relay mode (its scenario), against the simulator | A `workflow_dispatch` of `.github/workflows/parity-probe.yml` with `expect-failure: true`, once that file is on the default branch |
| R14 | Job mode feeds a three-leg matrix (simulator) | The scheduled or dispatched `parity-probe.yml` run, once on the default branch |
| R15 | Job mode routes with no relay deployed (simulator) | The same `parity-probe.yml` run |

I06 has its production run: `hobo ci diagnose` read
[run 44044299552](https://github.com/Hobo-Labs/HoBo/actions/runs/44044299552) of this
repository on 2026-11-17 and printed each failed job's step, the log lines it matched and
the re-run outlook, with no model.

### Owed gauntlet scenarios (T1, T2)

These cases are built and tested inside their packages, but their gauntlet scenario is
still tagged `@pending`, so the scorecard keeps the state the case had before the build.
The run that proves each is its scenario, written over the test named here and then run by
`node --import tsx scripts/ci/parity-scorecard.mts`.

| Case | Package test that covers it today | Note |
| ---- | --------------------------------- | ---- |
| R11, C03 | `packages/ci-gh-actions/test/relay-job-main.test.ts` | Job mode against the simulator |
| R07 | `packages/ci-gh-actions/test/billing-usage.test.ts` | |
| R08, P04 | `packages/ci/test/runner-order-spend.test.ts` | RunsOn has a reason, not a price |
| R09 | `packages/ci/test/runner-order-provider-health-sqlite.test.ts`, `packages/hobo/test/ci-provider-health.test.ts` | |
| R10, R12 | `packages/ci-gh-actions/test/auto-retry.test.ts`, `packages/hobo/test/ci-rerun-reroute.test.ts` | |
| R14, R15 | `packages/ci-gh-actions/test/relay-job-main.test.ts` | Both also owe T3 |
| M01, M02, M07 | `packages/ci-gh-actions/test/machine-worker-session.test.ts`, `packages/hobo/test/ci-machine-connect.test.ts` | |
| M04, M05, M06, M08, M09 | `packages/ci/test/runner-order-machine-registry.test.ts`, `packages/hobo/test/ci-machine.test.ts` | M08's email is met by the `machine.taken_over` event |
| M10 | `packages/ci-gh-actions/test/runner-adoption.test.ts` | The `hobo ci runners` command is not wired, so the bar's command does not exist |
| M13 | `packages/ci-gh-actions/test/machine-worker-executor.test.ts` | |
| I02 | `packages/ci-gh-actions/test/insight-ingest.test.ts` | |
| S03, S09 | `packages/ci-gh-actions/test/workflow-relay.test.ts`, `packages/hobo/test/ci-init-relay.test.ts` | |
| S04, X04 | `packages/ci-gh-actions/test/relay-mcp-insights.test.ts` | |
| S05, S07 | `scripts/test/error-catalog.test.ts` | The skills, the setup guide and [the error catalog](../ci/errors.md) |
| S06 | `packages/ci-gh-actions/test/read-api.test.ts` | |

## Where RelayRunner is stronger

- **It runs in production.** Its relay job is answered by a live gateway today. HoBo's relay
  mode, machines and checks have run only against the GitHub simulator; relay mode stays off
  until a production run is linked.
- **Time to first routed job.** Install an App, run one command on a laptop, add a relay
  job. HoBo's job mode needs no service, but relay mode still needs a relay to deploy and a
  secret store to bind.
- **Machines as a finished product.** A menu bar app, token rotation with a takeover email,
  and adopted runners driven from the CLI. HoBo has the takeover as an event and adoption as
  a library.

## Where HoBo is stronger or intentionally different

Each point with a case id is a **B** case at `pass` on the
[scorecard](../ci/parity-scorecard.md); its state there is what may be claimed. The last two
points are not scorecard cases.

- **More than one answerer, and a rescue for a lost webhook** (R16 and R13, `pass` at T2).
  Any mesh node may answer a relay job, and the job poller answers one whose webhook never
  arrived.
- **A fleet step** (R06b, `pass`). The top of an order can be isolated capacity that takes
  public repositories and fork pull requests. RelayRunner's machines refuse public
  repositories outright.
- **Routing is committed configuration** (S10, `pass`,
  [ADR-0181](../design/adr/routing-slips.md#adr-0181)). The order is reviewed like code; the
  dashboard's edit opens a pull request.
- **Diagnosis without a model** (I06, `pass`, run against GitHub). The failure kinds and the
  re-run outlook come from fixed, exported pattern tables; no log text leaves the machine.
- **Budget is reserved, not estimated.** Every admission reserves the job's maximum cost in a
  ledger and settles the measured cost; the spend limit reads that ledger first.
- **Self-hosted** (*intentional*). The relay is a package and a container an operator runs.

### Aimed at, not yet claimed

These **B** cases are aimed at points where HoBo would be stronger, but their scorecard
state does not allow the claim yet. Each is claimed only once it reaches `pass`.

| Case | Scorecard state | Intended difference | What would prove it |
|---|---|---|---|
| R15 | `not-built` | Job mode routes on a GitHub-hosted runner with the job's own token, so a relay outage changes nothing; RelayRunner's relay job stays queued when the gateway does not answer. | The R15 gauntlet scenario over `packages/ci-gh-actions/test/relay-job-main.test.ts`, then a `parity-probe.yml` run on GitHub with no relay reachable (T3). |
| R14 | `not-built` | One relay output routes a three-leg matrix; RelayRunner routes one job per relay and cannot route a matrix. | The R14 gauntlet scenario over `packages/ci-gh-actions/test/relay-job-main.test.ts` (T2), then a `parity-probe.yml` matrix run (T3). |
| M07 | `partial` | A fresh container per machine job by default on Linux; RelayRunner runs a job on the host as the signed-in user outside one Mac VM mode. | The M07 gauntlet scenario over `packages/ci-gh-actions/test/machine-worker-session.test.ts`, showing two jobs on one machine each in its own container (T2). |

## Adversarial critique

- **The pick runner rides an undocumented protocol.** The gateway impersonates the runner
  program; a GitHub change to that protocol, or to what a runner without a real machine may
  do, breaks routing for every customer at once. Its own notes list the failure modes: a
  lost `queued` webhook leaves a relay with nothing to rescue it, and a relay nobody claims
  stays queued for up to a day.
- **One relay per job.** Matrix jobs and reusable workflows cannot be routed, and a run with
  more than one relay is not retried.
- **Spend limits are list-price arithmetic.** Two of the seven providers have no prices, so
  no limit; none of it reconciles with an invoice.
- **A laptop is still a laptop.** Outside the Mac VM mode, a job runs as the signed-in user
  with that user's files in reach; the public-repository rule is the only hard line.
- **The dashboard is the configuration.** The order, retries and sizes change with no
  commit, review or history a repository can see.

## Better-together / integration posture

- **Borrow** (done in `@hobo/ci`): the runner order as a written preference, relay inputs,
  skip reasons, the minutes runway, provider health with trials, retry targets, `auto`
  sizes, and the nine signals as report definitions. The code is HoBo's own; nothing was
  copied from the Apache-2.0 sources.
- **Benchmark** on time to first routed job and on the relay job's cost.
- **Displace** where an operator wants the fleet, the budget ledger and committed routing.
- Coexistence is possible but pointless on one job: both products would put a job in front
  of the same `runs-on`.

## Threats and lessons

1. **The relay job is the product.** HoBo now answers one in two ways, but only job mode
   can be proven without touching production; relay mode's claim waits on one live run.
2. **Onboarding is a feature.** One command on a laptop is the bar. `hobo ci machine
   connect` meets it in the simulator; the relay-mode path is still longer.
3. **Reasons beat status.** "No runner available: the machine is paused" is what makes
   fail-fast acceptable. HoBo's relay job fails with that sentence as an annotation in
   the simulator, in job mode and relay mode; R04 stays built, not proven, until a
   production run shows it.
4. **Parity is a scorecard, not a list.** A capability counts when its scenario passes at its
   tier; the [scorecard](../ci/parity-scorecard.md) is regenerated, not edited.

## Sources

- [Repository](https://github.com/relayrunner/relayrunner) at commit `43b7c4c`: `README.md`,
  `PRODUCT.md`, `docs/architecture/pick-runner.md`, `apps/api/src/routing.ts`,
  `packages/runner-order`, `packages/providers`, `packages/machine-protocol`
- [Product docs](https://relayrunner.app/docs): routing, runner order, relay inputs,
  optimized checks, signals, telemetry
- HoBo side: [runner order](../../packages/ci/RUNNER-ORDER.md),
  [`@hobo/ci`](../../packages/ci/README.md), [CLI](../../packages/hobo/CI.md),
  [routing slips](../design/adr/routing-slips.md)

Pricing, customer counts, the hosted service's live behaviour and the contents of the
separate `relayrunner/actions` repository were not verified in this pass and are not
asserted. Provider label formats in HoBo's catalog were read from each vendor's own
documentation, not from RelayRunner.
