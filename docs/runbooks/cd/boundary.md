---
type: Runbook
title: "HoBo.CD runbook: Standards boundary"
description: "CDEvents, CloudEvents webhooks and the neutral-core scan. Assembled from the Runbook section of packages/cd/src/boundary/README.md."
tags: [hobo, cd, runbook, boundary]
---

# HoBo.CD runbook: Standards boundary

CDEvents, CloudEvents webhooks and the neutral-core scan. This page is assembled from the **Runbook** section of `packages/cd/src/boundary/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Code | Action |
|---|---|---|
| Sink refuses to start | `webhook-endpoint-invalid` | Use an absolute https URL with no userinfo or fragment. |
| Every delivery throws before sending | `webhook-secret-missing` | Store `{ secret }` under the configured `secretRef`; HoBo never sends unsigned. |
| `hobo.cd.boundary.webhook.dead_letters{code=webhook-rejected}` rises | `webhook-rejected` | The receiver answers 4xx: check its secret and signature verification (it must verify `id.timestamp.body` exactly as sent), then replay the dead letters. |
| `…{code=webhook-retries-exhausted}` rises | `webhook-retries-exhausted` | Receiver down or overloaded for ~2 min of backoff. Fix the receiver, then replay. |
| Receiver reports `webhook-timestamp-stale` | — | Clock skew > 5 min between sender and receiver; fix NTP. |
| `notify` throws | `notification-channel-unknown` | Add the channel to `createNotificationPort({ channels })` or correct the hook's channel name. |
| `hobo.cd.boundary.cdevents.skipped` grows | — | A journal body does not parse against the generated schema: an upcaster is missing upstream. The event was not sent. |
| A projector throws | `cdevent-invalid` | Bug: an event failed the pinned schema check. Report the source event id; nothing was sent. |
| Upgrading the CDEvents spec | — | Bump `STANDARDS.lock.json` and `CDEVENTS_SPEC`/`CDEVENT_TYPES` together, update `assertCdEvent` rules from the new schemas, regenerate the golden file. |
