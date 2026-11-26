---
type: Runbook
title: "HoBo.CD runbook: Camp inventory"
description: "Conditions, claims, taints and Camp sets. Assembled from the Runbook section of packages/cd/src/inventory/README.md."
tags: [hobo, cd, runbook, inventory]
---

# HoBo.CD runbook: Camp inventory

Conditions, claims, taints and Camp sets. This page is assembled from the **Runbook** section of `packages/cd/src/inventory/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **Camp shows `hobo.cd/unreachable` but its reconciler runs.** The Station
  has not appended a reconcile status event for it in 90 s. Check the agent's
  feed connection and `deployment.*` events on `cd-camp-status-<id>`. After a
  Station restart, contact recorded before the restart counts only until 90 s
  past its recorded time; a live reconciler clears the taint within one
  renewal (10 s).
- **`hobo.cd/credential-invalid`.** Look at the condition reason:
  `svid-refresh-failed` (refresh refused — check identity issuer and DPoP
  clock skew) or `svid-expiring-unrefreshed:<expiry>` (the agent stopped
  refreshing — restart it; re-enroll if its key was revoked).
- **`hobo.cd/claims-inconsistent`.** The reason lists the contradicting
  `name=value`. Either the agent runs somewhere other than declared (move it
  or fix the topology through a `topology` Delta) or it misreports. The Camp
  is never placed while this holds.
- **`hobo.cd/failed` (`NO_RUN`).** Added by the Rail rule; the reason lists
  the signal sources. Investigate, then `untaint` it as an operator; nothing
  clears it automatically.
- **A Camp set lists the wrong Camps.** `list({campSets: [name]})` shows
  membership; selectors read declared labels, env types, ids and the
  jurisdictions of declared regions (every region must match).
