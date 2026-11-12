# `@hobo/cd/windows`: change windows

Change windows say when a Camp may change (D10, I17). A window is `ALLOW` or
`FREEZE`, with a selector, an RFC 5545 RRULE subset, an IANA time zone and a
`rollback_allowed` flag. The promotion gate evaluates windows. Rollouts check
them at each stage boundary, and the pipeline controller checks them before
each auto-promotion request. Overrides are governed, expiring and audited.
This folder is half of work package WP5 of
[plan 0024](../../../../docs/plans/0024-hobo-cd-swarm-instruction.md).

| Export | What it does |
|---|---|
| `createChangeWindows` | Implements the frozen `ChangeWindows` port: `define`, `list`, `override` and `evaluate`. Its deps are `CdFactories["createChangeWindows"]` plus an optional `telemetry`. |
| `parseChangeWindow` | Parse boundary for window documents (protobuf JSON). It defaults an omitted `rollbackAllowed` to `true`. |
| `compileWindow` | Parses a `ChangeWindowRecord` into its compiled form, or refuses with every problem. |
| `evaluateWindows` | The pure evaluation: windows, active overrides and one Camp at one instant for one intent. |
| `parseRrule`, `occurrenceStarts` | The RRULE subset and its wall-clock expansion. |
| `toLocal`, `fromLocal`, `offsetAt`, `isTimeZone` | Zone arithmetic through `Intl`, with no clock. |
| `WINDOW_REASON`, `WINDOW_METRIC`, `WINDOW_LABELS`, `WINDOW_LIMITS`, `RRULE_LIMITS` | Wire contract: refusal codes, metric names, label keys and bounds. |

## Design

- **The RRULE subset.** `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` with `BYDAY`,
  `BYMONTHDAY`, `BYMONTH`, `BYHOUR`, `BYMINUTE`, `INTERVAL`, `COUNT` and
  `UNTIL`.
  - `BYDAY` ordinals (`1MO`, `-1FR`) are allowed with MONTHLY and YEARLY.
  - Anything else is refused, never ignored: `BYSETPOS`, `WKST`,
    `BYSECOND`, `BYWEEKNO`, `BYYEARDAY`, sub-daily `FREQ`, `COUNT` with
    `UNTIL`, and ordinals combined with `BYMONTHDAY`.
  - DTSTART is `starts_at`. It counts as an occurrence only when it matches
    the rule.
  - A month without the start day is skipped, not clamped (RFC 5545).
- **DST-correct.** Occurrences are expanded in wall-clock time in the
  window's zone and then mapped to instants:
  - an ambiguous reading (the repeated hour when clocks fall back) is the
    earlier instant;
  - a skipped reading (when clocks spring forward) moves forward by the
    length of the gap.

  A window's length is exact milliseconds (`duration_ms`). A single
  occurrence is `[starts_at, ends_at)`. A recurring window lasts
  `duration_ms`, or `ends_at − starts_at` of its first occurrence. Golden
  tests cover `America/Chicago` and `Europe/London` on both transitions.
- **Which windows apply.**
  - A window the node names applies when its selector covers the Camp. An
    empty selector covers every Camp.
  - A window the node does not name applies when it has a non-empty selector
    that covers the Camp. This is how organization-wide freezes work.
  - Selector jurisdictions and Bindles are read from the Camp labels
    `hobo.cd/jurisdiction` and `hobo.cd/bindle`. When the label is missing,
    a FREEZE still applies and an ALLOW does not, so uncertainty only
    narrows what is permitted.
- **Decision.**
  - FREEZE dominates ALLOW. When ALLOW windows apply, change is permitted
    only inside one of them.
  - An unexpired override lifts one window for the Camps it names.
  - Rollback is blocked only by a FREEZE that has `rollback_allowed=false`.
    ALLOW closure never blocks rollback.
  - `nextOpenAtMs` is the first boundary within 366 days where the decision
    opens.
- **Fail closed.** An unknown named window, a definition the journal cannot
  decode, and a rule that cannot be expanded (5,000 empty periods in a row)
  all close the window for changes. They are reported in `activeFreezes`.
  Rollback stays allowed (D10).
- **Commands and events.**
  - `define` appends `window.Defined` to `cd-window-<name>`. `override`
    appends `window.Overridden` to the same stream.
  - Appends use stream-head CAS and idempotency keys: `window:<digest>` and
    `override:<digest>`. Redefining identically is a no-op (I12).
  - A catch-up projection over both event types is the read store. It is
    rebuilt from the journal on start.
  - Evaluation is pure over the projection and the instant the caller
    passes (I8).
- **Governance (D15).**
  - `window.define` and `window.override` go through `CdAuthorizer`. A
    proposal-only principal, such as an agent, is refused.
  - An override needs a reason, explicit Camps and an expiry no more than
    `CD_DEFAULTS.windowOverrideMaxMs` (4 h) ahead. The decision id and the
    granting principal are recorded.
- **Rollback default.** proto3 cannot tell an unset `rollback_allowed` from
  `false`. Documents parsed with `parseChangeWindow` default it to `true`
  (D10). Records built in code must set it explicitly.

## Metrics

All metrics are counters on `TelemetrySink` and carry a `tenant` attribute:

- `hobo.cd.windows.defined` (`kind`)
- `hobo.cd.windows.overridden` (`window`)
- `hobo.cd.windows.refused` (`operation`, `code`)
- `hobo.cd.windows.evaluated` (`intent`, `open`)
- `hobo.cd.windows.unreadable` (`window`)

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| Promotions sit in `AWAITING_WINDOW` | A FREEZE is active or no ALLOW window is open for the Camp. | Run `evaluate` (or `hobo deploy windows`) for the Camp. `activeFreezes` names the windows and `nextOpenAtMs` says when it opens. Wait, or grant a governed override. |
| `activeFreezes` names a window that does not exist | A node names an undefined window, so it fails closed. | Define the window, or remove the name from the pipeline node. |
| `hobo.cd.windows.unreadable` rises; every Camp reports a freeze named after the stream | A `window.Defined` body in `cd-window-<name>` cannot be decoded. | Redefine the window (a newer valid definition clears it) or restore the stream from backup. Rollback stays allowed meanwhile. |
| `window-rrule-invalid` | The rule is outside the accepted subset. | Rewrite it with the parts listed above. Use `BYDAY=-1FR`-style ordinals only with MONTHLY or YEARLY. |
| `window-timezone-invalid` | The runtime's tz database does not know the zone. | Use an IANA name. Upgrade Node's ICU data if a new zone is missing. |
| A window opens an hour off after a DST change | The rule was written in UTC (`timezone: UTC`). | Set the business zone (for example `America/Chicago`). Expansion then follows wall-clock time. |
| `window-override-too-long` | The override expiry is more than 4 h ahead. | Grant a shorter override, and grant another when it expires. |
| `window-proposal-only` | An agent tried to define or override a window. | A granted human or service principal performs the action. |
| `window-journal-conflict` | Both CAS attempts lost to concurrent writers, or the store is unavailable. | Retry. Commands are idempotent. |
