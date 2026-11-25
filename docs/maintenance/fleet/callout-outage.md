---
type: Runbook
title: "Fleet runbook: callout outage"
description: "New NATS connections fail because no HoBo Fleet auth-callout responder answers, or the callout refuses devices it should admit."
tags: [hobo, fleet, runbook, maintenance, nats]
---

# Callout outage

Every device connects to NATS through the auth callout: the authority's
responders verify the session ticket and the device's proof and return a
10-minute user JWT. The callout is a single point of failure for **new**
connections, so it runs as two or more responders in one queue group.

**Signals:** the `fleet-nats-callout` row of the status page (target 0.9995
monthly), a burst of `hobo_fleet_callout_refused`, devices reporting the bus
down after their 10-minute credential expires. Callout p99 is meant to stay
under 300 ms.

## What still works

Existing connections continue until their credential expires. After that a
device runs standalone ([NATS server loss](./nats-server-loss.md), quorum
case): the box keeps taking work it sees itself.

## Steps

1. **No responder answers.** Check the authority replicas are running and
   connected as the `authority` user (`GET /readyz`). Restart a replica that
   is up but not subscribed to the callout subject. In the high-availability
   profile every replica is a responder; scale up if one is not enough.
2. **Responders refuse.** Read the reason on `hobo_fleet_callout_refused`:
   - ticket expired or of an older incarnation: the device must refresh;
     check the authority is issuing credentials;
   - proof does not match the registry's `SIGN` key: the device's record or
     bundle changed; check for a rotation or a [clone alarm](./clone-alarm.md);
   - member not `ACTIVE`: expected for suspended, locked or revoked members;
   - the server's request signature fails: the account's callout `xkey` or
     the responders' configuration changed; redeploy the matching
     configuration.
3. **Clock skew** on responders or devices breaks ticket and proof expiry;
   check `hobo_fleet_clock_skew`.
4. Verify: a device restart reconnects, and the status row recovers.
