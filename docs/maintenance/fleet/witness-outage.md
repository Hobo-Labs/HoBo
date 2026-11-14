---
type: Runbook
title: "Fleet runbook: witness outage"
description: "The HoBo Fleet witness is down or refusing: checkpoints are not final, trust rotation waits, and a refusal may mean the authority changed the registry without an audit entry."
tags: [hobo, fleet, runbook, maintenance, security, audit]
---

# Witness outage

The witness is the only check on the authority. It recomputes the audit
chain from its own reading of `FLEET_AUDIT`, watches `fleet-registry`, and
co-signs a checkpoint only when every registry change it saw has a matching
audit entry. A trust record changes only with its co-signature.

**Signals:** `hobo_fleet_witness_lag` (three checkpoints in a row without a
co-signature); `hobo_fleet_witness_refused` with a reason.

## Down (lag, no refusal)

Checkpoints are signed by the authority but not final; trust rotation
waits; nothing else stops.

1. Restart the witness. Standalone: it runs on the authority host under
   another OS account. High availability: on its own host.
2. Check it connects as the `witness` NATS user and can read its key from
   the secret store.
3. Verify: the next checkpoint is co-signed, `hobo fleet audit verify`
   passes, and a pending trust rotation completes when `hobo fleet ops
   rotate-key` is run again.

## Refusing

Treat a refusal as a possible compromise of the authority until explained.

1. Read the reason. A registry change with no audit entry means a record was
   written to `fleet-registry` without the journal event that should explain
   it: by the authority, or by someone holding the `authority` NATS user or
   the record-signing key.
2. Stop changes: no enrollment approvals or rotations while it is open.
3. Compare the registry key and record sequence the witness names with the
   journal. If nothing explains it, rotate `record-signing`
   ([rotate keys](./rotate-keys.md)), rotate the `authority` NATS user's
   credentials, and raise the incarnation by a restore from the last good
   backup ([backup and restore drill](./backup-and-restore-drill.md)).
4. A trust-record refusal (sequence not one above the pinned record, wrong
   signer, no matching `fleet.TrustRotated` entry) means the proposal was not
   made by `hobo fleet ops rotate-key`; do not override it.
