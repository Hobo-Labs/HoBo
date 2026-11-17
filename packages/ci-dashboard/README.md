# @hobo/ci-dashboard

The HoBo CI relay's dashboard: one read-only page with five views over the
relay's read API ([ADR-0183](../../docs/design/adr/runner-order.md)).

| View | Shows | Read API paths |
| --- | --- | --- |
| **Runners** | What needs attention first (offline, paused, full, running jobs on the host), then connected machines, adopted self-hosted runners and the HoBo fleet as the route journal saw it | `/machines`, `/routes` |
| **Router** | The committed runner order with each step's limit and health, the recent decisions with every step passed over, and a what-if panel. With no repository picked it shows the newest decision's repository, and only that repository's decisions | `/runner-order`, `/routes`, `/machines` |
| **History** | Stored runs; an opened run attempt (looked up among its own repository's newest 50 runs, or a line saying it is not there) shows its jobs, step timings and the diagnosis of each failed job | `/runs`, `/runs/{id}/{attempt}/jobs` |
| **Performance** | Times by workflow, by job and runner (each against `ubuntu-latest`), and by runner | `/job-times` |
| **Signals** | The nine signals with their offenders, a breakdown by person, repository, workflow, branch and event, and a per-day trend | `/signals` |

## Read-only by construction

The page sends only `GET` requests, only to its own origin, and only to the
frozen read API paths. Its CSP allows no other connection and no form
submission. The relay checks the account token (scope `policy:read`) on every
request; the page keeps that token in the tab's session storage and nowhere
else.

**Changing the routing is a commit.** The Router view's "Edit in a pull
request" opens GitHub's editor for `.hobo/ci.json`
(`https://github.com/<owner>/<repo>/edit/<ref>/.hobo/ci.json`). Saving there
on a new branch opens a pull request; the relay reads the committed order,
so nothing changes until it merges. A repository whose default branch
requires pull requests makes that the only way.

## The what-if panel

The Router view runs the walk in the browser: `decideRunnerRoute` from
`@hobo/ci`, the same function the relay answers a relay job with. The
question crosses the same parser a relay job does (`parseRelayJobMessage`
then `relayRouteRequest`). The labels and the person who started the run
are seeded from the newest decision; the machines are the read API's, online
when their advert is less than 90 seconds old. The person sets the rest: a
public repository or a fork, whether the fleet has room, the share of
included minutes used, and which hosted runner types to treat as failing to
start jobs. The panel reads nothing and journals nothing.

A question the relay would refuse is answered with the reason, never with
silence: `answerWhatIf` returns a refusal sentence (for example a Started by
that is not a GitHub user id, which the field also asks for with
`pattern="[0-9]{0,20}"`), and the page shows it in `#what-if-answer`.

## Diagnosis

A failed job in History is diagnosed with `diagnoseFailure` from
`@hobo/ci/insights`, from its steps only: the read API carries no logs. The
view prints the sentence and the evidence it rests on, or says there is
none and names `gh run view --log-failed`.

## Mounting it on a relay

`createDashboardRoute()` answers `GET /dashboard` (the page) and
`GET /dashboard/app.js` (the bundled client), and returns `undefined` for
any other path, the same shape as `createReadApi` in `@hobo/ci-gh-actions`.
Mount both on one origin so the page reads the read API with no
cross-origin request:

```ts
import { createDashboardRoute } from "@hobo/ci-dashboard";
import { createReadApi } from "@hobo/ci-gh-actions";

const dashboard = createDashboardRoute();
const readApi = createReadApi(deps);
const route = async (request: Request) =>
	(await dashboard(request)) ?? (await readApi(request));
```

A token can be handed to the page in the fragment, which never reaches the
server: `/dashboard#token=<token>`. The client moves it into session storage
and wipes it from the address bar.

## Architecture

The dashboard sits on the read side of the relay's event-driven CQRS. It
issues no command and appends no event. The relay's actors write the event
store: the route journal of `runner.route.Requested` and
`runner.route.Decided` events, the machine registry fed by signed adverts,
and the stored runs folded from GitHub's webhooks. The read API serves those
as its read store, and the signal, job-time and usage reports as projections
computed over stored runs. Each view is a materialized view of that read
store, rendered at read time; a page load is a snapshot of it at that
moment, kept nowhere.

Types follow parse, don't validate. Stored records cross the `@hobo/ci`
parsers (`parseRunnerRouteEvent`, `parseMachineAdvert`, `parseRunFact`,
`parseRunnerOrder`) and arrive as checked, frozen derived types; reports
cross the read API's report shapes. The two records the dashboard owns, the
address (`DashboardLocation`, parsed by `parseDashboardLocation`) and the
what-if question (`WhatIfQuestion`), are defined in
`data-models/ci_dashboard.proto` with CUE constraints beside it, and
`test/data-models.test.ts` checks the parser and the CUE agree.

## Tests

| File | Proves |
| --- | --- |
| `test/read-api.pact.test.ts` | Every request the views make is covered by the read API's provider pact, all `GET`, and is the committed consumer pact `contracts/read-api.pact.json`; every body parses; refusals keep their code and command |
| `test/data-models.test.ts` | `parseDashboardLocation` and `data-models/ci_dashboard.cue` agree |
| `test/views.test.ts` | What each view shows, in what order, escaped |
| `test/what-if.test.ts` | The walk in the panel: machine, minutes limit, failing runner type, waiting, none |
| `test/route.test.ts` | The page, the script, the CSP, `GET` only |
| `test/design-lint.test.ts` | Palette, outlines, flat lamps, focus rings, WCAG AA contrast by day and night |
| `test/dashboard.browser.test.ts` | The built page in Playwright's Chromium headless shell against a mock read API built from the provider's pact: the five views, the what-if, the edit link, only `GET` to its own origin, the accessibility checks on every view, a keyboard focus ring, and each view by day and night against its screenshot in `test/visual/` (0.2% of pixels may differ) |

The browser test launches the browser CI launches: Playwright's own Chromium
headless shell, which the CI runner image bakes in and a GitHub-hosted job
downloads at the same pinned revision (`CI_RUNNER_PLAYWRIGHT_CHROMIUM` in
`scripts/lib/ci-runner-contract.mts`). `PLAYWRIGHT_CHROMIUM_PATH` may name
another binary; a system Chrome is never tried. Without a browser the test is
skipped and says so on a workstation, and fails under `CI=true` or
`HOBO_REQUIRE_BROWSER=1`, so a CI host never reports the accessibility and
visual checks green unrun.

The screenshots were taken in that headless shell (Chromium 151.0.7922.34,
revision 1234). The visual check forces the bundled Liberation Sans
(`test/visual/fonts/`, SIL OFL 1.1) on every element and shoots a fixed
1280x2400 viewport, so neither the machine's fonts nor a view's height
changes the image. In another browser version the comparison is skipped on a
workstation and fails in CI. After a Playwright upgrade, refresh the images in
the new headless shell with
`UPDATE_VISUAL=1 pnpm exec vitest run test/dashboard.browser.test.ts`, update
`VISUAL_BROWSER_VERSION`, and review the images before committing.
