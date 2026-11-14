---
type: Runbook
title: "Fleet runbook: enroll, suspend, unlock, revoke"
description: "Member lifecycle for HoBo Fleet: bootstrap tokens, approval, declaring backends and targets, suspending a lost device, unlocking after a clone alarm, and revoking."
tags: [hobo, fleet, runbook, maintenance, identity]
---

# Enroll, suspend, unlock, revoke

Every action here is governed: it is a policy decision recorded as
`policy.Decided`, needs a signed-in person (`hobo fleet login`) with the
right tag, and lands in the audit chain. States are described in
[HoBo Fleet](../../design/fleet.md#enrollment).

## Enroll a device

| Path | Command |
|---|---|
| Token | `hobo fleet token create --fleet <id> --name <n> --ttl 900 > t`; on the device `hobo fleet enroll --token-file t` |
| Browser | On the device: `hobo fleet enroll --fleet <id> --name <n>` |
| Workload identity | `hobo fleet enroll --fleet <id> --oidc <token-file>`; accepted without a person when an `oidc_trust` rule matches, as `EPHEMERAL` at `T3` |

Then, unless policy is `AUTO_OWNER`: `hobo fleet member approve <id>` and
`hobo fleet member accept <id>` (from two different principals under
`DUAL`). Before approving, compare the four fingerprint words with the ones
the device printed. A token is single use; an unfamiliar fingerprint under
the invited name means the token leaked: reject it (`member reject`) and
issue a new one. List and revoke outstanding tokens with `hobo fleet token
list` and `hobo fleet token revoke <hash>`.

Add an `ACTIVE` member to another fleet: `hobo fleet member assign <id>
--fleet <other> --name <n> --role <r>`.

## Declare a backend or target

`hobo fleet member declare --fleet <id> --kind backend|target --name <n> …`
with a credential reference (a locator, never the secret). A sponsored
member is never `LOCKED`; revoking it removes it from every view.

## Suspend and resume

Suspend a device that is lost, misbehaving or under investigation:
`hobo fleet member suspend <id> --reason <r>`. It is not ranked and gets no
orders; its next refresh is refused (`member-suspended`). `hobo fleet member
resume <id>` reverses it. A device the authority suspended on a violation
report is handled in the [claim-violation alarm](./claim-violation-alarm.md).

## Unlock

A `LOCKED` device had two agents present one key. Follow the
[clone alarm](./clone-alarm.md) to decide which machine is real; only then
`hobo fleet member unlock <id>`, which resets the generation.

## Revoke

`hobo fleet member revoke <id> --reason <r>` is terminal. Live readers stop
honouring the member's signatures within 5 seconds of seeing the registry
change; its next refresh is refused; its NATS session credential expires
within 10 minutes. Every thumbprint it ever had stays bound, so its keys can
never enroll again. A device retiring itself runs `hobo fleet leave`.

For a revocation that must take effect at the bus without the authority
(the authority itself is suspect), remove the scoped signing key of the
device's template from the tenant account and push the account with the NATS
operator tools; no credential of that template can be minted or renewed
until a new key is provisioned ([rotate keys](./rotate-keys.md)).
