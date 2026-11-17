# Run history, usage and signal breakdown

A relay that keeps a journal keeps each workflow run attempt it hears about, so
the insight reports can read stored history instead of asking GitHub each time
([ADR-0183](../../../docs/design/adr/runner-order.md)). The stateless hosted
relay keeps none; there the reports still read GitHub on demand.

## Where the history comes from

`InsightIngest` in `@hobo/ci-gh-actions` takes GitHub's `workflow_job` and
`workflow_run` webhooks and folds each one into the stored run attempt.

- `parseInsightWebhook(event, body)` is the one place a payload becomes run,
  job and step facts. Any other event gives nothing; a malformed payload
  throws.
- A job that arrives before its run starts the attempt from what the job
  carries. The event reads `unknown` until the run's own webhook fills it in.
- A run webhook sets the attempt's own fields and keeps its jobs. A job webhook
  replaces only that job.
- A finished run or job is never replaced by an older, unfinished view of it,
  and a job a runner has taken is never replaced by a queued view of it, so a
  webhook that arrives late or twice changes nothing.
- A job counts as started only when a runner name is on it, because GitHub
  stamps a start time on jobs no runner has taken.
- A job is billed when it ran on GitHub's own runners (every label is a
  GitHub-hosted label, or its runner group is `GitHub Actions`) and either
  the repository is private or the runner is a larger runner. GitHub bills
  larger runners in public repositories too; only standard hosted runners are
  free there ([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
  read 2026-11-17). A larger runner is a macOS `-large` or `-xlarge` label, or
  a label that is not a standard hosted label in the `GitHub Actions` group. A job named `relay` or `route`, or one that asks for
  the `hobo-relay` label, is a relay job and is left out of waits.
- Each folded attempt is checked as a `RunFact` before it is stored.
- The stored run has no place for the repository's visibility. Each parsed
  fact carries it as `repositoryPrivate`, so a consumer can keep the public
  repositories the usage report needs.

Webhooks for one attempt are applied one at a time, in the order they were
delivered. One relay partition owns the store.

## Where it is kept

`SqliteInsightStore` (`@hobo/ci/insights/history-sqlite`) keeps one `RunFact`
per repository, run id and attempt in `node:sqlite`. Storing an attempt again
replaces it. Reads come back newest first, bounded by a start time and a limit.
Repository names match without regard to case.

## Usage

`usageReport(runs, options)` (`@hobo/ci/insights/usage`) reports, overall, per
runner type and per UTC day:

- billed minutes, rounded the way GitHub bills a job: up to a whole minute,
  never less than one;
- the waste in billed jobs shorter than a minute;
- minutes kept off GitHub-hosted runners, priced at GitHub's rate;
- relay jobs answered without a billed minute;
- billed minutes against the plan's included minutes, with a burn rate, when
  a minutes reader could read them.

The report holds no price of its own. The caller passes GitHub's per-minute
rate with the page it was read from and the day it was read. That rate prices
only what GitHub did not bill: kept minutes and relay savings. Billed minutes
stay minutes, because GitHub bills macOS, Windows and larger runners at their
own rates.

A job ran on GitHub's own runners when it was billed, when its runner group is
`GitHub Actions` (larger runners on custom labels report it), or when every
label is a GitHub-hosted label. Every other finished job is kept off GitHub.
A larger-runner job counts as billed even when it was stored unbilled, because
GitHub bills larger runners in every repository (`githubBillsJob` and
`isLargerRunnerJob` hold the rule).

The caller must name the public repositories (`publicRepositories`, an empty
set when there are none). GitHub does not bill standard hosted runners in a
public repository, so its kept minutes are counted but priced at nothing. The option is required so a
caller cannot overstate the savings by leaving it out.

## Signal breakdown

`signalBreakdown(runs)` (`@hobo/ci/insights/breakdown`) splits the nine CI
signals by person, repository, workflow, branch and event, and trends them per
UTC day. Its totals are exactly what `ciSignals` returns for the same runs, and
the slices of each signal add up to that total.
