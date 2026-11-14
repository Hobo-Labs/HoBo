---
type: Runbook
title: "Fleet runbook: install and upgrade"
description: "Deploy NATS, the fleet authority, the witness and the peer-to-peer relays in the standalone or high-availability profile, upgrade them, and move a deployment onto the fleet."
tags: [hobo, fleet, runbook, maintenance, deploy]
---

# Install and upgrade

The assets are in [`deploy/fleet/`](../../../deploy/fleet/README.md); its
"Before the first start" section is the authoritative list of secrets and
files. Profiles are described in
[HoBo Fleet](../../design/fleet.md#deployment-availability-and-operations).

## Install

1. **Key ceremony.** `hobo fleet ops ceremony --config <authority.json>`
   against the OpenBao the config names. It prints the NATS operator key as
   two shares; give them to two different people and store neither on a
   host. It refuses to run twice (`conflict`).
2. **OAuth clients.** Register the authority as an OAuth client with GitHub
   and with the organisation's identity provider; store the client secrets in
   the secret store. Until then only the test sign-in provider exists.
3. **Files.** Write `operator.conf` from `<secretPrefix>/operator-jwt`; place
   the NATS, relay and authority TLS material and each workload's OpenBao
   token as `deploy/fleet/README.md` lists; edit `config/*.json` (issuer
   origin, tenant, NATS and relay URLs, OpenBao address).
4. **NATS.** Start NATS (one server standalone, three in high availability).
   Pin 2.15.3 or later; never below 2.14.3.
5. **Provision once.** `docker compose -f deploy/fleet/compose.<profile>.yml
   run --rm provision`, or apply the kustomization and let the
   `hobo-fleet-provision` job run. This is `hobo fleet ops provision
   [--replicas 1|3]`, an operator task; no service holds the provisioner's
   credentials.
6. **Start the rest:** the authority (two or more replicas in high
   availability), the witness (another OS account standalone, another host in
   high availability), the relays. `GET /readyz` on the authority must answer
   200.
7. **Fleets.** `hobo fleet fleet apply <policy-file>` for each fleet. A
   `ONE_ACTIVE` policy is refused by the authority (`one-active-authority`):
   one-active fleets run only in local mode.
8. **Enroll devices** ([enroll, suspend, unlock, revoke](./enroll-suspend-unlock-revoke.md)).
   On the CI box: drain and stop the worker, enroll it with a token, start the
   new worker.

## Moving an existing relay's cache fleet

Deploy the relay with `membership_epochs` false. It reads its existing
assignment log, keeps the same active backend and keeps writing format 1,
which the previous relay also reads, so redeploying the previous relay and
worker image goes back. After a full day of normal runs, delete the retired
repository variables and the old buckets (`*-mesh-nodes`, `*-mesh-claims`,
`*-mesh-config`), then set `membership_epochs` true. The next tick decides
the pin entry and the log moves to format 2; from then on the previous relay
cannot read the log and problems are fixed forward. Every relay instance must
run one configuration while the pin is being decided.

## Upgrade the services

Images are the release images of the
[release service images runbook](./release-service-images.md); set
`HOBO_FLEET_VERSION` (and `HOBO_FLEET_IMAGE_PREFIX`). Upgrade one authority
replica at a time; the journal's compare-and-set keeps replicas consistent
while versions are mixed. Upgrade NATS servers one at a time and wait for
each to rejoin the cluster ([NATS server loss](./nats-server-loss.md) applies
if one does not). Upgrade the witness last; checkpoints wait for it, nothing
else does.

## Upgrade a device

There is no self-update. A fleet's `min_agent_version` refuses older agents
at ranking and at credential refresh (`agent-outdated`,
`hobo_fleet_update_required`). Raise it only after the new version is
installed where it needs to be; reinstall with whatever installed the old
one, then `hobo fleet service install` again if the unit changed.
