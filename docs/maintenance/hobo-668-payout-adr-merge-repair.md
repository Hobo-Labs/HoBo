---
type: Reference
title: "Maintenance note - HOBO-668"
description: "Maintenance note for the HOBO-668 payout ADR merge-conflict repair."
tags: [hobo, maintenance]
---

# Maintenance note - HOBO-668

Date: 2026-07-02

This branch repair merged `origin/main` into the HOBO-668 payout-readiness ADR
branch, resolved the ADR numbering conflict by keeping main's ADR-0107 through
ADR-0109 records, and moved the marketplace payout-readiness decision to
ADR-0110.

The merge also refreshed empty `pnpm-lock.yaml` workspace importers for draft
proof packages already present after the main merge so the frozen-install check
continues to pass on the repaired PR branch.
