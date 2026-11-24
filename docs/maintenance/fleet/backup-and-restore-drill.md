---
type: Runbook
title: "Fleet runbook: backup and restore drill"
description: "Back up the HoBo Fleet event store and audit stream, restore into a fresh deployment with an incarnation increment, and rehearse it."
tags: [hobo, fleet, runbook, maintenance, backup]
---

# Backup and restore drill

The authority's only durable state is its event store; the registry and
view buckets are rebuilt from it. Losing every bucket loses nothing. Losing
the event store is recovered from a backup.

## Back up

`hobo fleet ops backup <archive> --config <authority.json>` writes one
`hobo-fleet-backup/v1` file (mode 0600): the witnessed checkpoints, every
audit entry, the journal and the pinned trust record, with a manifest of
SHA-256 digests. The standalone journal is a consistent SQLite snapshot.
Schedule it; the standalone profile's recovery point is the last backup.
Store archives off the host.

## Restore

1. Deploy a fresh authority and witness ([install and
   upgrade](./install-and-upgrade.md)); do not start devices against it yet.
2. `hobo fleet ops restore <archive> --config <authority.json>`. It refuses
   an archive whose digests do not match, of another tenant, or into a
   deployment that is not fresh (`conflict`).
3. It loads the journal, restores the trust record, audit entries and
   checkpoints, waits for the witness to co-sign them, raises the authority
   incarnation in a witnessed trust record (`fleet.TrustRotated`, reason
   `restore`) and rebuilds the registry under the new incarnation. A second
   run continues where the first stopped and does not raise the incarnation
   twice.
4. Every credential issued before the restore is refused with
   `incarnation-stale`; devices refresh by themselves. Members enrolled after
   the backup enroll again.
5. Verify: `hobo fleet audit verify` passes; `hobo fleet status` shows every
   pre-backup member `ACTIVE` after its next refresh.

## Drill

Once a quarter, restore the latest archive into a scratch deployment, run
step 5 against it, and record the date and the time taken in this runbook.

## Known limit

The high-availability restore answers `unavailable`: the journal store can
only append new envelopes, and a restore must keep every envelope id the
audit log names. In that profile restore `FLEET_JOURNAL` and `FLEET_AUDIT`
with a JetStream stream restore, then run `restore` for the incarnation
step.
