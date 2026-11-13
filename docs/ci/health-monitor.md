---
type: CI Runbook
title: "CI health monitor: loud fallbacks"
description: "What the CI health monitor reads every two hours, the seven signals it raises (H1, H2, H3, H4, H6, H8, H10), its window and request budget, its issues, and what to do when one opens."
tags: [hobo, ci, relay, routing, fleet, monitoring]
---

# CI health monitor: loud fallbacks

Every fallback to a default must leave a record something reads. The monitor is that reader: it turns the
route job's notices, the fleet's queue waits, paid minutes and the hosted relay's reporter status into issues,
so a signal that stops carrying a value is raised within two monitor runs instead of failing silently. Design:
[plan 0025, section 6.6](../plans/0025-relay-owned-runner-routing.md); verdict authority:
[ADR-0180](../design/adr/fleet-verdict.md#adr-0180).

| Piece | Where |
| --- | --- |
| Script (node builtins only, runs straight from a checkout) | [`scripts/ci/ci-health.mts`](../../scripts/ci/ci-health.mts) |
| Tests and recorded fixtures | `scripts/test/ci-health.test.ts`, `scripts/test/fixtures/ci-health/` |
| Workflow (every two hours and on dispatch) | [`.github/workflows/ci-health.yml`](../../.github/workflows/ci-health.yml) |
| Lint allowance: one GitHub-hosted job, `ci-health`, that runs the monitor and nothing else | `scripts/lint-actions.ts` (`lintHealthWorkflow`) |

The workflow holds `actions: read`, `checks: read`, `issues: write`, `id-token: write`, and `contents: read`
for its sparse checkout of the monitor and `.hobo/ci.json`. It needs no `pnpm install`: Node 24 runs the
`.mts` file directly.

## What it reads

**Window.** From the `windowEnd` of the newest uploaded `ci-health-report` artifact to now; the last two hours
when there is none. Every run uploads its report, breach or not, so a breaching run still moves the window
on. A run that could not read its window (rate limit, request budget, API failure) uploads a report whose
`windowEnd` is the previous one, so the next run reads that window again.

**Requests.** At most 100 runs, newest first (`truncated` in the report when more fell in the window); each
run's jobs (one page); the annotations of two check runs per run, the route job (**Route runners**) and, on
main-gate runs, **Main workspace plan**, whose `reroute` step prints the same titles. With the artifact, the
OIDC token, the relay's status route and the issue calls, a run makes at most 320 requests against a hard
budget of 350. A rate-limit answer ends the run as failed (exit 2) without opening an issue.

**The relay.** `GET /v1/fleet/reporters/{owner}/{repo}` on the relay `.hobo/ci.json` names, with a GitHub
Actions OIDC token whose audience is that origin. When the route cannot be reached or refuses the token, H4
and H10 read `unknown`, which is not a breach on its own; an `unknown` after an `unknown` raises H2's issue
with that note.

## Signals

| Signal | Computed from | Breach | First thing to check |
| --- | --- | --- | --- |
| **H1** routing did not run | `hobo-ci-route-fallback` warnings | any | The route job's log: the route script or its sparse checkout failed |
| **H2** relay asked, no verdict | route notices with `relay: unanswered` over those with `verdict` or `unanswered` | more than 5% of at least 20, or all of at least 5; or the status route unread twice | The relay deploy's smoke check; the `why` in the evidence |
| **H3** relay not asked | route notices with `relay: unasked` and `why: no-relay` | any | `.hobo/ci.json` in that commit names an `https` relay |
| **H4** reporter silent | status route: a reporter in `shadow` or `report` whose `lastReportAt` is more than 10 minutes old | any | The box daemon; its clock (refused `clock-skew`); its key (refused `bad-signature`); its enrollment |
| **H6** stall | jobs on `hobo` or `hobo-trunk` that waited, or have been queued, more than `CI_HEALTH_STALL_MINUTES` (default 30) for a runner; **Main full gate** is left out (it waits on its concurrency group) | any | The box and ARC: a fleet that was refusing work the verdict did not block |
| **H8** paid minutes | per job on `ubuntu-24.04`, started to completed rounded up to the minute, leaving out the route job, the gates and this monitor; split by what refused the fleet (`relay`, `queue`, `none`, `fallback`, `unrouted`) | more than `CI_HEALTH_PAID_MINUTES_PER_WINDOW` (default 150) | Which split carries the minutes |
| **H10** allowance spent | status route | any label | The box: a label blocked for its whole daily allowance is a fleet stuck refusing |

`unrouted` minutes belong to runs with no route notice: workflows without a route job, and every run before
the route step printed notices.

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
Outside a workflow there is no OIDC token, so H4 and H10 read `unknown`. The report is written to
`ci-health-report.json` (`CI_HEALTH_REPORT_PATH` to change it) and to the step summary.

The first local dry run against the live repository (2026-11-12, two-hour window, before the route notices
reached `main`) read 100 runs (`truncated`) in 160 requests: H1, H2, H3 and H6 clear, H4 and H10 `unknown`,
and H8 at 565 paid minutes, all `unrouted`. Revisit the H8 default once the notices are on `main`.
