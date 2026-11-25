---
type: Proof
title: "Station control-plane occupancy proof"
description: "Station control-plane occupancy proof"
tags: [hobo, design]
---

# Proof note: Station control-plane occupancy (ADR-0131)

## Claims

1. Station is isolation-bound occupancy, not app-topology containment.
2. Bootstrap Rail is content-addressed least-privilege; production forbids bootstrap-only.
3. Connections are Station-scoped; cross-Station use fails closed without federation grant.
4. Conductor receipts pin `stationId` + `railHash` when Station context is supplied.
5. `hobo station init` is the seed path; silent durable auto-init is not the default.

## Executable evidence

| Claim | Test / surface |
|---|---|
| station() idiom | `packages/stations/test/station.test.ts` |
| bootstrap + activate | same |
| cross-Station deny | `assertConnectionStationAccess` tests |
| init idempotent / import broker.json | `initStation` tests |
| CLI verb | `station` in `CANONICAL_VERBS` (ops/setup, not lifecycle) |
| Package architecture | `packages/stations/ARCHITECTURE.md` |

## Closed risks

- No dual-read Connections: `stationId` required on create and fold.
- No soft auto-init: `resolveStationContext` never creates durable state.
- Conductor always requires `stationId` + `railHash` pins.
- Cross-Station Connection use requires explicit `federationGrant: true`.
