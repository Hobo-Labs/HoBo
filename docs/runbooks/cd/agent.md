---
type: Runbook
title: "HoBo.CD runbook: Agents and enrollment"
description: "Agent identity, DPoP and double opt-in enrollment. Assembled from the Runbook section of packages/cd/src/agent/README.md."
tags: [hobo, cd, runbook, agent]
---

# HoBo.CD runbook: Agents and enrollment

Agent identity, DPoP and double opt-in enrollment. This page is assembled from the **Runbook** section of `packages/cd/src/agent/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **Agent stuck PENDING.** Read `cd-reconciler-<id>`: which of
  `KeyApproved`/`Accepted` is missing? Grant it as a principal the policy pack
  allows; under `separate_approvers` the two grants need different principals.
- **`enrollment-incomplete` at the feed.** Same as above; the feed refuses
  until both grants (or a matching Rail auto-accept) are recorded (I24).
- **`token-used` / `token-expired`.** Tokens are single-use, 1 h by default
  (max 24 h). Issue a new token; a retry with the same key after a network
  failure succeeds idempotently.
- **`dpop-stale`.** Agent clock is off by more than 60 s; fix NTP.
- **`dpop-replayed` bursts.** A proxy is retrying requests verbatim; disable
  request replay in the proxy. The agent mints a fresh proof per request.
- **`svid-invalid` after a Station restart or on another replica.** The
  Station replicas must share one SVID issuer key (compose `issuer`); with the
  default process-local key, agents re-activate by key possession
  automatically.
- **`hobo.cd/credential-invalid` taint.** See the inventory reason:
  `svid-refresh-failed` (check issuer and clock), `reconciler-revoked`
  (expected after revoke), or an expiring SVID (agent stopped refreshing —
  restart it).
- **Key compromise.** `revoke(id)`; the next request from that key is
  refused everywhere. Enroll a new key with a new token; the old key can never
  re-enroll.
- **`egress-refused` at agent start.** The configured Station URL is not an
  HTTPS origin, carries credentials/paths, or points at a metadata or
  link-local address. Fix `--station`.
