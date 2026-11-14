---
type: Runbook
title: "Fleet runbook: one-active fleet stuck sealed"
description: "A local-mode one-active fleet (the hosted relay's cache fleet, a Postgres fleet) is sealed with no active member for longer than twice its seal wait."
tags: [hobo, fleet, runbook, maintenance, relay, data-plane]
---

# One-active fleet stuck sealed

A planned move seals the fleet first (no member is active) and then
activates the target. Each tick either activates, keeps waiting, or reseals
when the target is unreachable. A fleet sealed for longer than twice
`sealWaitMs` raises `hobo_fleet_assignment_sealed_too_long`. One-active
fleets run only in local mode, inside the process that writes their
members' stores; the authority has no part in them.

**Signals:** `hobo_fleet_assignment_sealed_too_long`; `hobo_fleet_assignment_tick`
with `action` `sealed-waiting`, `reseal`, `no-majority` or `undecided`; for
the relay, its retryable unavailable error on cache reads.

## Steps

1. **Read the tick.** `no-majority` or `undecided` means fewer than a
   majority of the members answered: the fleet stops rather than guess. Fix
   reachability or credentials of the members first (the classified health
   is on the tick: `UNREACHABLE`, `QUOTA_EXHAUSTED`, `AUTH`).
2. **Is the activation scheduled?** For the relay, the activation is a queue
   message; check the queue consumer is running and not failing. The next
   tick activates or reseals in any case.
3. **A member lost its log** (a cache flushed): the next tick re-admits it
   once a majority agrees on the current entry; nothing to do.
4. **The configured member list changed** with `membership_epochs` on: the
   fleet changes one member per epoch, decided by the old set. Wait one tick
   per changed member. With it off, the configured set decides as before.
5. **Last resort.** The host that owns the register may call
   `overrideAssignment` from its own operator tooling. There is no HTTP route
   for it; record why in the incident.
6. Verify: the tick reports `keep` (or `single` for one member) and the
   alarm clears.
