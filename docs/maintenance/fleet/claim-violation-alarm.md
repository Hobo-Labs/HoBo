---
type: Runbook
title: "Fleet runbook: claim-violation alarm"
description: "A dispatcher reported a signed claim that breaks the rules and the HoBo Fleet authority suspended the device, or claims are being discarded."
tags: [hobo, fleet, runbook, maintenance, security]
---

# Claim-violation alarm

**Signals:** `hobo_fleet_violation_reported` and a `fleet.MemberSuspended`
for the reported device; `hobo_fleet_claim_discarded` counts at a
dispatcher.

A dispatcher checks every claim on its offers. A claim with a bad signature,
or one that does not match its subject or offer, is deleted and attributed
to nobody: anyone can publish garbage or replay a claim. A validly signed
claim from a device that is not `ACTIVE`, not an executor in that fleet, does
not fit the offer, or cannot provide the tier the work needs is deleted and
reported with the claim as evidence; so are three claims more than one rank
early from one device inside an hour. The authority verifies the evidence
itself and suspends the device. A device is suspended only on evidence it
signed itself.

## Steps

1. **Discards with no report** are expected noise (forged or replayed
   claims). A sustained rise points at a misbehaving publisher on the bus:
   check which NATS user publishes them.
2. **A device was suspended.** Read the report's reason with
   `hobo fleet member show <id>` and the audit entry.
   - **Early claims:** compare clocks (`hobo_fleet_clock_skew`) and the
     device's view of the fleet. An honest agent that is out of date or
     skewed: fix it, then `hobo fleet member resume <id>`.
   - **Out of fleet, or a tier it cannot provide:** check the device's
     memberships and its sandbox self-test (`hobo fleet doctor`). A wrong
     configuration: fix and resume. No explanation: revoke
     ([enroll, suspend, unlock, revoke](./enroll-suspend-unlock-revoke.md)).
3. **A dispatcher reports too much** (many devices suspended at once):
   suspect the dispatcher. Suspend its membership, check its version and
   configuration, and resume the devices it reported once the cause is
   known. Reports are refused with `evidence-invalid` when the evidence does
   not prove the violation.
