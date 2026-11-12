---
type: Runbook
title: "HoBo.CD runbook: Change windows"
description: "Freezes, allow windows and overrides. Assembled from the Runbook section of packages/cd/src/windows/README.md."
tags: [hobo, cd, runbook, windows]
---

# HoBo.CD runbook: Change windows

Freezes, allow windows and overrides. This page is assembled from the **Runbook** section of `packages/cd/src/windows/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

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
