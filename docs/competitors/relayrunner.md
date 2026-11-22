---
type: Competitive Reference
title: "RelayRunner — Competitor Reference"
description: "A hosted gateway that sends each GitHub Actions job to the first runner in an ordered list that can take it: a teammate's connected machine, an existing self-hosted runner, a hosted provider, or GitHub-hosted. The closest shipped product to HoBo CI's relay, with a feature-by-feature parity ledger."
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
> against the hosted service. Read alongside [CI fleet balancing](https://github.com/Hobo-Labs/HoBo/blob/3e96e0a51e5f0d286cd9639898913ae0d304c8ba/docs/design/ci-fleet-balancing.md),
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
| `finops` | RelayRunner routes by a written order with minutes and spend limits; HoBo reserves budget per job in a ledger and ranks published offers by cost. |
| `provider-matching` | Both name hosted runner providers by label; RelayRunner's list is longer and wired into routing. |
| `observability` | RelayRunner has a dashboard of signals and performance; HoBo has a journal, traces, a health monitor and CLI reports. |
| `agent-surface` | Both ship an MCP server; RelayRunner adds setup skills and a workflow-rewriting `init`. |

## Primitive mapping

| RelayRunner | HoBo CI | Honest correspondence |
| ----------- | ------- | --------------------- |
| Runner order | `RunnerOrder` in `@hobo/ci`, committed as `runnerOrder` in `.hobo/ci.json` | **Close in rules, different in home.** The same walk, limits, health and retry rules, plus a `fleet` step RelayRunner has no equivalent of. HoBo's order is committed configuration; nothing walks it at run time yet. |
| Relay job | The repository's route job and `runs-on: ${{ needs.route.outputs.runner }}` | **Partial.** HoBo's route job is repository-local, runs on a GitHub-hosted machine and reads a routing slip. It is not an installable product surface. |
| Pick runner | none | **Absent.** Nothing in HoBo speaks the runner protocol in place of a machine. |
| Connected machine | `local` provider, `hobo ci serve --with-worker`, the local runner | **Partial.** HoBo has single-use runners, slots and graceful shutdown, but no one-command join outside a checkout, no sharing model and no macOS. |
| Adopted runner | `externalPools` | **Not the same.** HoBo counts such runners for a capacity verdict; it does not route to them. |
| Hosted provider label | `label` financial models, bridge offers | **Partial.** Blacksmith and Depot are offers on the Node relay; the others are labels in the runner-order catalog only. |
| Minutes and spend limits | Per-offer budget, free minutes, account thresholds | **Different mechanism.** HoBo reserves and settles per job; it does not read GitHub's included-minutes usage. |
| Provider health | Mesh reliability, launch-failure guard | **Different subject.** HoBo scores its own nodes; the runner order's health record covers hosted labels and is not yet fed by a host. |
| Automatic retry | Orphan and stall recovery on the box | **Partial.** HoBo re-runs lost jobs on the box worker; the runner order's retry rules are not yet applied by a host. |
| Optimized checks | none | **Absent** as a check run; the title rule exists as a function. |
| Signals, performance, diagnosis | `@hobo/ci/insights`, `hobo ci signals`, `hobo ci diagnose` | **Close in rules, different in surface.** Computed from GitHub's history on demand in a terminal; no stored history and no dashboard. |
| Workspace, roles | Account, installation, scoped bearer tokens | **Different.** HoBo has tenants and token scopes, no human roles. |

## Parity ledger

State labels follow the research contract: *implemented* means in `packages/` with tests,
*partial* means a narrower form exists, *not present* means nothing in the repository does
it. Checked 2026-11-16.

| RelayRunner capability | HoBo state | Where |
| ---------------------- | ---------- | ----- |
| Ordered runner list, walked first-fit | *implemented* as a library and a CLI; no host walks it at run time | `packages/ci/src/runner-order/decide.ts`, `hobo ci route` |
| A job uses only runner types its relay named | *implemented* in the walk | `decide.ts`, `inputs.ts` |
| Skip reasons recorded per step ("show why") | *implemented*: 17 reasons, kept on `RunnerRouteDecision` | `data-models/runner_route.proto` |
| Minutes limit with runway | *implemented* as a rule; the usage read is *not present* | `limits.ts` |
| Monthly spend limit per provider | *implemented* as a rule; the spend sum is *not present* | `limits.ts` |
| Queue when busy, fail fast otherwise | *implemented* in the walk (`waiting`, `none`); the route job still never fails a run | `decide.ts` |
| Unhealthy runner types skipped, with trials | *implemented* as a state machine; not fed by a host | `health.ts` |
| Automatic retry on runner loss | *partial*: classification and policy implemented; box-worker recovery is separate | `retries.ts`, `isolated-worker/orphan-jobs.ts` |
| `auto` sizes | *implemented* for seven providers, Linux x64, with sources | `providers.ts` |
| Public repositories never on machines | *implemented*, and stricter: forks too | `decide.ts`, `hosted-relay.ts` |
| Relay job answered with no runner and no minutes | *not present* | n/a |
| Installable relay workflow | *not present*; the route job is repository-local | `.github/actions/route-runner` |
| Machine joins with one command | *partial* | `hobo ci serve --with-worker` |
| Machine sharing, pause, slots | *partial*: rules implemented in `chooseMachine`; no enrollment, no pause command | `machines.ts` |
| Adopt existing self-hosted runners | *not present* as a routing target | n/a |
| Per-job VM on a Mac, menu bar app | *not present*; Linux x64 only | n/a |
| Hosted provider labels in routing | *partial*: catalog and walk implemented; relay offers cover Blacksmith and Depot | `providers.ts`, `fleet/models.ts` |
| Title check without a runner | *partial*: the rule is implemented, the check run is not | `insights/pr-title.ts` |
| Lint in a sandbox | *not present* | n/a |
| Repository configuration file | *implemented*: `.hobo/ci.json`, with a schema | `packages/ci-gh-actions/schema` |
| Nine signals | *implemented* as reports and a CLI; no stored history | `insights/signals.ts`, `hobo ci signals` |
| Per-runner and per-job times | *implemented* as reports; shown per runner in the CLI | `insights/job-times.ts` |
| Failed-job diagnosis and re-run outlook | *implemented*, deterministic, no model | `insights/failure-diagnosis.ts`, `hobo ci diagnose` |
| OpenTelemetry traces | *partial*: relay and worker spans, not one trace per run | `relay-trace.ts` |
| Dashboard | *not present* | n/a |
| `init` rewrites workflows | *implemented* for the fleet label (`runs-on: hobo`); it writes no relay job | `workflow-init.ts`, `hobo ci init` |
| Read-only MCP server | *implemented* for leases, events and the mesh; no insight tools | `relay-mcp-server.ts` |
| Agent skills for setup | *partial*: relay deploy only | `.claude/skills/hobo-deploy` |
| Error catalog | *partial*: stable `HOBO_CI_*` codes, no single page | `packages/hobo/src/ci-*.ts` |
| Human roles, email notifications | *not present* | n/a |

## Where RelayRunner is stronger

- **The relay job costs nothing and cannot be starved.** Because the gateway itself is the
  runner for the relay job, a routing decision needs no machine and no billed minute, and it
  is not delayed when the fleet is busy. HoBo's route job occupies a GitHub-hosted runner.
- **Time to first routed job.** Install an App, run one command on a laptop, add a relay
  job. HoBo's path has a relay to deploy, a secret store to bind and offers to publish.
- **Machines as a product.** Enrollment, sharing, pause, token rotation, a takeover email
  and a Mac VM mode are finished features; HoBo's laptop path is a developer workflow.
- **A dashboard.** Runners, router, history, performance and signals are one place a person
  can look. HoBo answers the same questions in a terminal.
- **Breadth of hosted providers in routing.** Seven by label, with usage sync for three.

## Where HoBo is stronger or intentionally different

- **A fleet step** (*implemented*, `@hobo/ci-gh-actions`). HoBo starts one-job runners in
  fresh containers or sandboxes it operates, so the top of an order can be isolated capacity
  that takes public repositories and fork pull requests. RelayRunner's own container runner
  is early access and its machines refuse public repositories outright.
- **Budget is reserved, not estimated** (*implemented*, `@hobo/ci`). Every admission reserves
  the job's maximum cost in a ledger and settles the measured cost; RelayRunner compares a
  month's list-price spend to a limit.
- **Admission knows the host** (*implemented*). Memory, disk, inodes, trunk priority, merge
  queue position and job length decide what the box takes next. RelayRunner counts slots.
- **Routing is committed configuration** (*implemented*, [ADR-0181](../design/adr/routing-slips.md#adr-0181)).
  The order and the routing policy are reviewed like code; no dashboard edit changes where
  production jobs run. RelayRunner's order is edited in the dashboard on purpose.
- **No hosted dependency in the decision** (*implemented*). The route job decides from a
  routing slip in the repository and GitHub's own queue, so a relay outage changes nothing.
  RelayRunner's relay job stays queued when the gateway does not answer.
- **Diagnosis without a model** (*implemented*, `@hobo/ci/insights`). The failure kinds and
  the re-run outlook come from fixed, exported pattern tables; no log text leaves the
  machine. RelayRunner's cause and outlook come from a hosted classifier.
- **Self-hosted** (*intentional*). The relay is a package and a container an operator runs.

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

1. **The relay job is the product.** Everything else follows from being able to answer a
   job without a runner. HoBo's order has no host that walks it until something does the
   same, or until the route job is shipped as an installable workflow.
2. **Onboarding is a feature.** One command on a laptop is the bar. HoBo's secretless,
   self-hosted path is sound and long.
3. **Reasons beat status.** "No runner available: the machine is paused" is what makes
   fail-fast acceptable. HoBo records refusals; it has to put them where the job's author
   reads them.
4. **Reports need history.** Signals computed from a hundred recent runs are useful; a
   stored journal makes them trends.

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
