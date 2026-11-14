# HoBo Fleet runbooks

> Operator procedures for [HoBo Fleet](../../design/fleet.md)
> ([ADR-0183](../../design/adr/fleet.md#adr-0183)). The deployment assets they
> use are in [`deploy/fleet/`](../../../deploy/fleet/README.md). Every
> command is `hobo fleet …`; operator tasks are `hobo fleet ops … --config
> <path>` with the authority's own configuration file.

Status: the procedures are written against the built code and its tests.
Each is built, not proven in production, until a production run of it is
linked in the runbook.

| Runbook | When |
|---|---|
| [Quick start](./quick-start.md) | Enroll a first device and run work on it |
| [Install and upgrade](./install-and-upgrade.md) | Deploy NATS, the authority, the witness and the relays; upgrade them; move a deployment onto the fleet |
| [Enroll, suspend, unlock, revoke](./enroll-suspend-unlock-revoke.md) | Member lifecycle: tokens, approvals, a lost or retired device |
| [Rotate keys](./rotate-keys.md) | Scheduled or emergency rotation of each of the eight keys |
| [Backup and restore drill](./backup-and-restore-drill.md) | Take a backup; restore into a fresh deployment; rehearse it |
| [NATS server loss](./nats-server-loss.md) | One server, quorum or every server is lost |
| [Callout outage](./callout-outage.md) | New bus connections are refused |
| [Clone alarm](./clone-alarm.md) | A device is `LOCKED` with `generation-mismatch` |
| [Claim-violation alarm](./claim-violation-alarm.md) | A device was suspended on a violation report, or claims are being discarded |
| [Witness outage](./witness-outage.md) | Checkpoints are not co-signed; the witness refuses |
| [Relay outage](./relay-outage.md) | The peer-to-peer relays are down |
| [One-active fleet stuck sealed](./one-active-fleet-stuck-sealed.md) | A cache or Postgres fleet has no active member |
| [Release service images](./release-service-images.md) | How the authority, witness and relay images are built, attested and published |

## Alarms and where they point

| Log event | Runbook |
|---|---|
| `hobo_fleet_member_locked` | [Clone alarm](./clone-alarm.md) |
| `hobo_fleet_violation_reported`, `hobo_fleet_claim_discarded` | [Claim-violation alarm](./claim-violation-alarm.md) |
| `hobo_fleet_witness_lag`, `hobo_fleet_witness_refused` | [Witness outage](./witness-outage.md) |
| `hobo_fleet_callout_refused` (a burst), the `fleet-nats-callout` status row | [Callout outage](./callout-outage.md) |
| `hobo_fleet_bus_status`, `hobo_fleet_claims_unreachable` | [NATS server loss](./nats-server-loss.md) |
| `hobo_fleet_transport_selected` falling back from `p2p` | [Relay outage](./relay-outage.md) |
| `hobo_fleet_assignment_sealed_too_long` | [One-active fleet stuck sealed](./one-active-fleet-stuck-sealed.md) |
| `hobo_fleet_update_required` | [Install and upgrade](./install-and-upgrade.md#upgrade-a-device) |
