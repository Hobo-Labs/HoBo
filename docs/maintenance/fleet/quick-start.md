---
type: Runbook
title: "HoBo Fleet quick start"
description: "Enroll a first device into a fleet and run work on it: sign in, create a bootstrap token, enroll, run the agent, check status."
tags: [hobo, fleet, runbook, maintenance]
---

# HoBo Fleet quick start

Enroll one device and run work on it. You need an authority URL (an
operator runs one: [install and upgrade](./install-and-upgrade.md)) and a
person allowed to invite into the fleet. Background:
[HoBo Fleet](../../design/fleet.md).

## 1. Point the CLI at the authority

```sh
export HOBO_FLEET_AUTHORITY_URL=https://fleet.example.com
hobo fleet doctor        # discovery, JWKS, key store, sandbox tiers, clock skew
```

`doctor` names each tier this machine can provide (`S1_CONTAINER`,
`S2_USER_KERNEL`, `S3_MICROVM`). The agent provisions its own pinned gVisor
`runsc`; nothing has to be installed on the host for `S1` and `S2` beyond a
Linux kernel that permits root or user namespaces.

## 2. Enroll

On a machine with a browser, enroll in one step. The CLI signs you in with
the device's new identity key and the approval page shows four fingerprint
words; check they match what the CLI prints.

```sh
hobo fleet enroll --fleet <fleet-id> --name <device-name> --class personal
```

Or with a bootstrap token (single use, 10 to 30 minutes). A person creates
it; the device reads it from a file or standard input, never from the
command line:

```sh
hobo fleet login
hobo fleet token create --fleet <fleet-id> --name <device-name> --ttl 900 > token.txt
# on the device:
hobo fleet enroll --token-file token.txt
```

A fleet whose approval mode is `SINGLE` or `DUAL` leaves the device
`PENDING` until approvers run `hobo fleet member approve <id>` and
`hobo fleet member accept <id>` (two different people for `DUAL`). Under
`AUTO_OWNER` the owner's own sign-in is the approval.

## 3. Run the agent

```sh
hobo fleet run                 # foreground
hobo fleet service install     # or as a systemd unit, launchd agent or Windows task
hobo fleet status --fleet <fleet-id>
```

A `PERSONAL` device runs work authored by its owner's linked identities at
`S1` or higher, organisation work only at `S3`, and never fork or public
work. Keys live in `HOBO_FLEET_HOME` (default `~/.hobo/fleet`, refused inside
a git checkout).

## 4. Leave

```sh
hobo fleet leave    # revokes this device with its own credential and deletes its keys
```
