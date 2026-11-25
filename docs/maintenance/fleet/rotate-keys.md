---
type: Runbook
title: "Fleet runbook: rotate keys"
description: "Rotate each of the eight HoBo Fleet keys with hobo fleet ops rotate-key: add, publish, switch, remove, resumable at every step, with no outage."
tags: [hobo, fleet, runbook, maintenance, security, keys]
---

# Rotate keys

`hobo fleet ops rotate-key <key> --config <authority.json>` does add,
publish, switch, remove, in that order. Each step is idempotent and its
progress is stored before the next starts, so an interrupted rotation is
finished by running the same command again. A device that refreshes every
second sees no refused request during a rotation. Details:
[`@hobo/fleet-authority` operations](../../../packages/fleet-authority/src/ops/README.md).

| Key | Publish | Grace before remove |
|---|---|---|
| `record-signing` | A new trust record, journalled as `fleet.TrustRotated`, proposed on `fleet.audit.trust`; it takes effect only once the witness co-signs | 30 minutes |
| `witness` | The same, for the witness key | 30 minutes |
| `token-signing` | The new key joins the token ring; the old one verifies for 15 more minutes | 15 minutes |
| `operator-signing`, `account-signing`, `scoped-observer`, `scoped-executor`, `scoped-dispatcher` | Published to NATS | 30 minutes |

## Steps

1. Check the witness is co-signing (`hobo fleet audit verify` succeeds and
   no `hobo_fleet_witness_lag` is firing). A trust-record rotation waits for
   it; see [witness outage](./witness-outage.md).
2. Run `hobo fleet ops rotate-key <key> --config <file>`. The result names
   the last step reached: `add` (publication could not happen yet: the
   witness or NATS is unavailable), `switch` (waiting for the grace period),
   or `done`.
3. Run it again until it answers `done`.
4. Verify: `hobo fleet audit verify` passes; for a trust-record key, devices
   accept the new record (it verifies against the pinned record's keys).

## Emergency rotation

For a leaked record-signing key, rotate `record-signing` and then raise the
incarnation by a restore if records signed with the leaked key must stop
being honoured before they expire ([backup and restore
drill](./backup-and-restore-drill.md)). A leaked key alone cannot replace the
trust record, because the witness must co-sign it, and the witness refuses
to co-sign a checkpoint while a registry change has no audit entry.

## Known limit

The NATS signing-key publication (`operator-signing`, `account-signing`,
`scoped-*`) answers `unavailable` in the shipped composition, so those
rotations stop at `add`: publishing an account's signing keys needs an entry
point `@hobo/fleet-nats` does not have, and the operator JWT needs the
ceremony's two shares. Until that is built, rotate those keys with the NATS
operator tools by hand: add the new key to the account JWT, push, let the
grace period pass, remove the old one, push.
