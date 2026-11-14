---
type: Runbook
title: "Fleet runbook: clone alarm"
description: "A HoBo Fleet device is LOCKED with generation-mismatch because two agents presented one key: decide which machine is real, then unlock or revoke."
tags: [hobo, fleet, runbook, maintenance, security]
---

# Clone alarm

**Signal:** `hobo_fleet_member_locked`; the device's refreshes answer
`generation-mismatch`; `hobo fleet member show <id>` shows `LOCKED`.

Each refresh advances a generation counter; a retry after a lost response
(same generation, same nonce) is answered again and never locks. Anything
else means two agents hold one key, and both are refused from that moment.

## Steps

1. **Treat it as a stolen key until shown otherwise.** Leave the device
   `LOCKED`; nothing it signs is honoured.
2. **Find both machines.** Ask the owner where the device runs. Look for a
   restored disk image, a cloned VM or container, a copied `HOBO_FLEET_HOME`,
   or the same home directory synced to a second machine.
3. **Decide.**
   - An honest copy (a cloned VM, a restored backup): stop the copy and
     delete its `HOBO_FLEET_HOME`. Then `hobo fleet member unlock <id>` (a
     governed action) and restart the agent on the real machine.
   - No honest explanation, or the owner cannot tell: `hobo fleet member
     revoke <id> --reason clone` and enroll the real machine again with a new
     key. Its old thumbprint can never enroll again.
4. **Harden.** A device that matters should hold its identity key in a
   keystore (`HOBO_FLEET_KEYSTORE=external-signer:<command>`, tier `T1`).

## Known limit

Detection needs both copies to refresh. A copy of a device that is switched
off works until the original comes back. Suspend a lost device at once
([enroll, suspend, unlock, revoke](./enroll-suspend-unlock-revoke.md)).
