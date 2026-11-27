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

Refreshed 2026-11-26, after the GitHub relay boundary, Alchemy Domain + EffectTS + Rivet host, `hobo ci runners` CLI, workflow restore, and all 57 scorecard cases were wired and verified
([ADR-0183](../ci/runner-order.md#adr-0183)).

| RelayRunner | HoBo CI | Honest correspondence |
| ----------- | ------- | --------------------- |
| Runner order | `RunnerOrder` in `@hobo/ci` (neutral core), committed as `runnerOrder` in `.hobo/ci.json` | **Close in rules, different in home.** The same walk, limits, health and retry rules, plus a `fleet` step RelayRunner has no equivalent of. HoBo's order is committed configuration; a change is a pull request. |
| Relay job & `runs-on` syntax | `parseGhRunsOn` / `formatGhRunsOn` / `GhRelay` Alchemy Domain in `@hobo/ci-gh-actions` | **Full functional parity, isolated to `@hobo/ci-gh-actions`.** Supports both single-label HoBo routing (`runs-on: hobo`) and RelayRunner-style `runs-on` / relay inputs (`size`, `first`, `auto`, `machine`, `github`, and all seven hosted providers) via EffectTS + `@alchemy.run/domain` + Rivet Durable Objects. Neutral `@hobo/ci` and non-GitHub CI packages stay free of GitHub specifics. |
| Pick runner | `createGhPickRunnerRegistry` (RivetKit SQLite actor) + `createGhRelayRivetLayer` (`@alchemy.run/domain/Rivet` Durable Objects) in `@hobo/ci-gh-actions/host` | **Built and simulator-verified (`R01`, `C01` T3 live production runs owed).** Registers a one-job runner, claims the relay job over the Actions runner protocol, and answers it; verified against the GitHub simulator and live Rivet 3.0.0 engine. |
| Connected machine | `hobo ci machine connect`, with `pause`, `resume`, `share` and `remove` | **Close.** One job per fresh container by default on Linux, slots, signed Ed25519 adverts with takeover detection (`machine.taken_over`), Linux and macOS (`--host` or `--vm`). |
| Adopted runner | `adoptRunner` / `releaseAdoptedRunner` + `hobo ci runners list\|adopt\|release` | **Same surface.** Adds or removes the HoBo adoption label via GitHub's runner-labels API and routes to adopted runners through the CLI and relay. |
| Hosted provider label | Runner-order catalog with dated labels and list prices | **Close.** Seven providers by label; RunsOn carries a reason instead of a price. |
| Minutes and spend limits | `GithubMinutesReader` (billing usage), `LedgerSpendReader` (the ledger, then list prices) | **Close, different source.** Spend is summed from what HoBo reserved and settled; capped steps fail closed while uncapped fallback keeps jobs moving when unmeasured. |
| Provider health | `ProviderHealthStore` in SQLite, `hobo ci provider-health clear <provider>` | **Same rule.** Persists across restarts, backs off with trial jobs, and clears by provider or target. |
| Automatic retry | `auto-retry.ts` on `workflow_run` completed | **Same rule.** Re-runs a job that failed before its own steps or lost its runner, at most twice per run and never twice for one delivery. |
| Optimized checks | Runner-less `pr-title` and 7-tool sandboxed `lint` (`actionlint`, `shellcheck`, `oxlint`, `oxfmt`, `ruff`, `zizmor`, `typos` with `paths` globs) in `@hobo/ci-gh-actions` | **Same surface.** Runs in a network-isolated container sandbox; `C01` T3 live run still owed. |
| Signals, performance, diagnosis | `@hobo/ci/insights`, `hobo ci signals`, `diagnose`, `activity`, `usage`, `performance` | **Close.** Stored in the relay's journal and history; diagnosis runs offline with no model. |
| Dashboard | `@hobo/ci-dashboard`, served by the relay over the read API | **Close, read-only.** Five views; "edit" opens a pull request. |
| Read API, MCP server | `/v1/accounts/self/...` with a generated OpenAPI 3.1 file; read-only MCP tools + 3 agent skills + setup/removal guides | **Same surface**, read scope only. |
| Workspace, roles | Account, installation, scoped bearer tokens | **Different (`S08`, `met-differently`).** HoBo uses GitHub membership plus scoped tokens rather than separate human roles. |

## Parity scorecard

The parity ledger that was here is replaced by the generated
[parity scorecard](../ci/parity-scorecard.md): 57 cases, one per thing RelayRunner says it
does, each with HoBo's bar, a tier and the state its scenario reached in the last run. The
page is written by `scripts/ci/parity-scorecard.mts` from the case catalog and the
scenarios under [`features/hobo-ci-parity`](../../features/hobo-ci-parity/README.md), and
`--check` fails when it is stale.

On 2026-11-26 all 62 parity scenarios (445 steps) pass with zero `@pending` tags. The
scorecard shows **54 `pass`**, **2 `built-not-proven`**, **0 `partial`**, **0 `not-built`**
and **1 `met-differently`** (`S08`: no human roles; access is GitHub membership plus scoped
tokens). Only the two T3 live production runs remain owed:

### Owed production runs (T3)

A T3 case needs a run in production. Neither of these was made from the build session,
because each changes production state or needs a workflow on the default branch.

| Case | Built | The run that would prove it |
| ---- | ----- | --------------------------- |
| R01 | Relay mode claims a check job in the simulator (`GhRelay` Alchemy Domain + Rivet host) | Turn `relayJobs.answer` on for this repository alone on the deployed relay, push a workflow whose check job asks for `hobo-relay`, and link the run: the check job completed, no billed minute, no runner |
| C01 | The `pr-title` check step in relay mode | The same relay-mode setup, with a pull request whose title breaks the rule: the check job fails with the annotation and no runner ran it |

I06 has its production run: `hobo ci diagnose` read
[run 44044299552](https://github.com/Hobo-Labs/HoBo/actions/runs/44044299552) of this
repository on 2026-11-17 and printed each failed job's step, the log lines it matched and
the re-run outlook, with no model.

## Where RelayRunner is stronger

- **It runs in production.** Its relay job is answered by a live gateway today. HoBo's relay
  mode, machines and checks pass all T1/T2 gauntlet scenarios against the GitHub simulator
  and Rivet test engine; `R01` and `C01` stay `built-not-proven` until live production runs
  are linked.
- **Time to first routed job.** Install an App, run one command on a laptop, add a relay
  job. HoBo needs a relay to deploy and a secret store to bind.
- **macOS menu bar app & email takeover alert.** RelayRunner ships a native macOS menu bar
  app and sends a takeover email; HoBo emits the `machine.taken_over` event on the machine
  registry and drives adoption/machines through the CLI.

## Where HoBo is stronger or intentionally different

Each point with a case id is a **B** case at `pass` on the
[scorecard](../ci/parity-scorecard.md); its state there is what may be claimed. The last two
points are not scorecard cases.

- **More than one answerer, and a rescue for a lost webhook** (R16 and R13, `pass` at T2).
  Any mesh node may claim a check job, and the job poller claims one whose webhook never
  arrived.
- **Matrix job routing** (R14, `pass` at T2). Each leg of a matrix job is routed through
  the `GhRelay` domain when HoBo CI answers it; RelayRunner routes one job per relay and
  cannot route a matrix.
- **Fresh container per machine job by default on Linux** (M07, `pass` at T2). Each job runs
  in a freshly started container removed on exit, rather than on the host as the signed-in
  user.
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

1. **Production proof beats simulator proof.** HoBo's `GhRelay` Alchemy Domain, Rivet host,
   RelayRunner-compatible `runs-on` parser, and all 62 T1/T2 gauntlet scenarios pass in the
   simulator; closing the remaining two T3 cases (`R01`, `C01`) requires live production runs
   on a deployed relay.
2. **Onboarding is a feature.** One command on a laptop is the bar. `hobo ci machine
   connect` and `hobo ci runners adopt` meet it in the CLI and simulator; the relay-mode
   setup still requires deploying a relay and binding a secret store.
3. **Reasons beat status.** "No runner available: the machine is paused" is what makes
   fail-fast acceptable. HoBo's walk and `GhRelay` domain fail with that sentence as an
   annotation (R04, T1); live production verification closes the loop on `R01`/`C01`.
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
