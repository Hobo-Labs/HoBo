---
type: CI Runbook
title: "CI health monitor: loud fallbacks"
description: "What the CI health monitor reads every two hours, the six signals it raises (H1, H2, H3, H6, H8, H11), its window and request budget, its issues, and what to do when one opens."
tags: [hobo, ci, relay, routing, fleet, monitoring]
---

# CI health monitor: loud fallbacks

Every fallback to a default must leave a record something reads. The monitor is that reader: it turns the
route job's notices, the fleet's queue waits and paid minutes into issues,
so a signal that stops carrying a value is raised within two monitor runs instead of failing silently. Design:
[ADR-0180](../design/adr/fleet-verdict.md#adr-0180-rules); routing authority: the box relay's
routing slip ([ADR-0181](../design/adr/routing-slips.md#adr-0181)), which replaced the hosted relay's verdict
([ADR-0180](../design/adr/fleet-verdict.md#adr-0180)) as what route jobs read. Of the relay it reads only the public `/healthz` (H11). H4
(reporter silent) and H10 (allowance spent) read the hosted relay's reporter status route, which was retired
with the verdict ([ADR-0181](../design/adr/routing-slips.md#adr-0181)), so they are no longer
computed and their numbers are not reused.

| Piece | Where |
| --- | --- |
| Script (node builtins only, runs straight from a checkout) | [`scripts/ci/ci-health.mts`](../../scripts/ci/ci-health.mts) |
| Tests and recorded fixtures | `scripts/test/ci-health.test.ts`, `scripts/test/fixtures/ci-health/` |
| Workflow (every two hours and on dispatch; a push to `main` runs only the transport probe) | [`.github/workflows/ci-health.yml`](../../.github/workflows/ci-health.yml) |
| Lint allowance: one GitHub-hosted job, `ci-health`, that runs the monitor and nothing else, beside the pinned `routing-slip-probe` job | `scripts/lint-actions.ts` (`lintHealthWorkflow`) |

The workflow holds `actions: read`, `checks: read`, `issues: write`, and `contents: read` for its sparse
checkout of the monitor, `.hobo/ci.json`, `pnpm-lock.yaml` and the relay's input closure
([`scripts/ci/relay-inputs.mts`](../../scripts/ci/relay-inputs.mts), which a step before the monitor writes to
`relay-inputs.json`); no OIDC token. It needs no `pnpm install`: Node 24 runs the `.mts` files directly.

## What it reads

**Window.** From the `windowEnd` of the newest uploaded `ci-health-report` artifact to now; the last two hours
when there is none. Every run uploads its report, breach or not, so a breaching run still moves the window
on. A run that could not read its window (rate limit, request budget, API failure) uploads a report whose
`windowEnd` is the previous one, so the next run reads that window again.

**Requests.** At most 100 runs, newest first (`truncated` in the report when more fell in the window); each
run's jobs (one page); the annotations of two check runs per run, the route job (**Route runners**) and, on
main-gate runs, **Main workspace plan**, whose `reroute` step prints the same titles. With the artifact, the
relay freshness reads and the issue calls, a run makes at most 315 requests against a hard budget of 350. A rate-limit answer ends the run as failed (exit 2) without opening an issue.

**Relay freshness.** `GET /healthz` on the same origin names the commit the relay serves; the repository's
default branch is compared with it (`GET /repos/{owner}/{repo}` and one `compare`), and the files changed since
are matched against the relay's source directories in `relay-inputs.json` (`packages/ci-vercel` and every
workspace package in its pnpm-lock closure). The relay deploys only through HoBo with the owner's store session,
never from a workflow, so nothing else notices a relay left behind its sources. A `/healthz` without a commit,
an unreadable comparison, or a comparison past GitHub's 300-file list with no relay file in it reads `unknown`.

**Route notices.** Each route decision prints one `hobo-ci-route` notice, version 2:
`{"v":2,"workflow","tier","runner","slip","why","refusedBy"}`, optionally with
`mergeGroupHostedProbe` (`idle`, `summary`, and on saturated hosted probes `trunkIdle`, `trunkSummary`, `runnerPageIdleTrunk`) on merge-group Fabric decisions; unknown fields are ignored. `runnerPageIdleTrunk` is observability only: it says the fetched runner page showed an online, unbusy `hobo-trunk` runner, but it never admits the batch to the trunk. Merge-group Fabric requires a verified Broker claim before any `hobo-trunk` route; without it the batch stays on `ubuntu-24.04`. The `fleet-probe` job named `hobo picks a job up` asks for plain `hobo` while the online trunk runners carry `hobo-trunk`, so a stuck `hobo` probe is not evidence those runners are busy. `slip` is `used` (the routing slip was consulted;
`why` is the relay's reason, such as `fleet-open` or `no-capacity`; `refusedBy: queue` shows a fleet slip
overruled because GitHub did not confirm timely pickup), `fallback` (no slip could be used and the
queue rule decided; `why` says which: `no routing slip`, `slip expired`, `slip malformed`, `slip names another
repository`, `slip names a label not in runnerRouting.labels`, or the Git API failure) or `unasked` (`why`:
`pinned`, `batch`, or `merge-group` on HoBo CI Fabric `merge_group` route jobs that skip the slip). `refusedBy` is `slip`, `queue` or `none`. A slip fallback also prints a
`hobo-ci-route-fallback` warning that starts `routing slip not used`; the monitor reads the notice for it, and
counts under H1 only the warnings that say the route did not run at all. An unreadable PR-batch hosted queue
fails the route job before it can emit a route notice or public-compute claim. For a saturated same-repository batch, the route job tries the fleet ladder before falling back to `ubuntu-24.04`, skipping `hobo-trunk` unless `runnerRouting.box.trunkLend` is `1`; when no fleet tier can be verified, the warning records the explicit hosted reason. Version-1 notices (the hosted relay's
`relay`/`verdict` fields) are no longer read.

## Signals

| Signal | Computed from | Breach | First thing to check |
| --- | --- | --- | --- |
| **H1** routing did not run | `hobo-ci-route-fallback` warnings that do not start `routing slip not used` | any | The route job's log: the route script or its sparse checkout failed |
| **H2** routing slip unusable | route notices with `slip: fallback` for any reason but `no routing slip` or `slip expired`, over those plus `slip: used` | more than 5% of at least 20, or all of at least 5 | The `why` in the evidence: a malformed slip or an unknown label points at the box relay's writer; an HTTP status or `not read in time` at the Git API |
| **H3** no routing slip | route notices with `slip: fallback` and `why` `no routing slip` or `slip expired` | any | The box relay: down, not restarted onto code that writes slips, or not the mesh leader; [finding 0149](findings/0149-routing-slip-facts-main-on-the-queue-rule-hosted-relay-down-box-on-c7ec8d449.md) |
| **H6** stall | jobs on `hobo` or `hobo-trunk` that waited, or have been queued, more than `CI_HEALTH_STALL_MINUTES` (default 30) for a runner; **Main full gate** is left out (it waits on its concurrency group) | any | The box and ARC: a fleet that was refusing work its routing slip did not refuse |
| **H8** paid minutes | per job on `ubuntu-24.04`, started to completed rounded up to the minute, leaving out the route job, the fleet probe's `local box enrolled` gate, the gates, this monitor and its `Routing slip transport` job; split by what refused the fleet (`slip`, `queue`, `none`, `fallback`, `unrouted`) | more than `CI_HEALTH_PAID_MINUTES_PER_WINDOW` (default 150) | Which split carries the minutes |
| **H11** relay stale | `/healthz` commit against the default branch, filtered to the relay's source directories | any relay source changed since the served commit | Deploy the relay from an owner store session: `hobo ci deploy --build prebuilt` after HoBo MCP's `choose_secret_store` ([CI.md](../../packages/hobo/CI.md#deploying-the-hosted-relay-with-hobo)) |

`unrouted` minutes belong to runs with no route notice: workflows without a route job, and every run before
the route step printed notices.

**Route fallbacks by reason.** Besides the signals, every report counts the route decisions of the window
that fell back to the queue rule because no routing slip could be used, by the `why` the route job gave
(`no routing slip`, `slip expired`, `slip names a label not in runnerRouting.labels`, `slip names another
repository`, `slip malformed`, an HTTP status, `the routing slip was not read in time`): the report's
`slipFallbacks` (`total`, `byReason`, most frequent first), a `Route fallbacks to the queue rule` line in the
step summary, and the absent-slip counts in H3's summary, for example `3 runs routed with no current routing
slip (no routing slip 2, slip expired 1)`. A box relay that stopped writing shows as `no routing slip` or
`slip expired` climbing from one report to the next ([ADR-0181](../design/adr/routing-slips.md#adr-0181)).

**The transport itself** is proved by the workflow's second job, **Routing slip transport**
(`routing-slip-probe`): it runs `scripts/ci/routing-slip-probe.mts --write` with its own `GITHUB_TOKEN` and
`contents: write` (that job only), writing `refs/hobo/routing-slip-probe` through the same Git Data API calls
the box relay uses, reading it back as the route job does, and deleting it. It fails when the read-back is
not a valid slip or the probe ref cannot be deleted, so a GitHub change that breaks the slip's transport
shows as a failed run, not as `no routing slip`. It runs on every push to `main` (where it is the only job
that runs, in its own concurrency group) as well as on the schedule, one probe at a time. It never touches
`refs/hobo/routing-slip`.

## Issues

For each breach the monitor opens an issue titled `[ci-health] <signal>: <summary>`, labelled `ci-health` and
assigned to `CI_HEALTH_ASSIGNEE` (an `env` in the workflow file); if GitHub refuses the assignee the issue is
opened unassigned. When an open issue already carries that signal's prefix it comments there instead. It never
closes an issue: close it once the cause is fixed. The run exits 1 on any breach, 0 when clear.

## Running it

```bash
# Locally, against the live repository: prints the report, writes no issue.
GITHUB_TOKEN=<a token that can read Actions> node scripts/ci/ci-health.mts --dry-run
```

`--dry-run` (or the workflow's `dry-run` input) prints and uploads the report under `ci-health-dry-run`, so it
does not move the scheduled window, writes nothing to issues and exits 0 unless the window could not be read.
The report is written to
`ci-health-report.json` (`CI_HEALTH_REPORT_PATH` to change it) and to the step summary.

The first local dry run against the live repository (2026-11-12, two-hour window, before the route notices
reached `main`) read 100 runs (`truncated`) in 160 requests: H1, H2, H3 and H6 clear, H4 and H10 (since retired)
`unknown`, and H8 at 565 paid minutes, all `unrouted`. Revisit the H8 default once the notices are on `main`.
