---
type: Reference
title: "Stations — occupancy, capabilities & localhost discovery"
description: "Narrative home for the Station concept: control-plane occupancy (ADR-0131), the typed Station capability manifest, and fail-closed localhost capability matching (ADR-0155)."
tags: [hobo, design, stations, capabilities]
---

# Stations — control-plane occupancy, capabilities & localhost discovery

> Capability doc for the **Station** concept ([ADR-0131](./adr/01-architecture-core.md#adr-0131), [ADR-0155](./adr/01-architecture-core.md#adr-0155)). Until now the Station design lived only in the ADR decision list, one glossary row, and a CLI table row — thinner than every sibling concept (Camp/Yard/Bindle each have narrative docs). This doc is the single narrative home; the ADRs stay canonical for the decisions themselves.

## 1. What a Station is (and is not)

A **Station** is the hard control-plane isolation boundary a Conductor occupies. One Station = one isolation domain — not multi-tenant by default.

The two axes of the HoBo vocabulary are orthogonal and must not be mixed:

| Axis | Nouns | Owner |
|---|---|---|
| **App topology (containment)** | `Bindle ⊂ Camp ⊂ Yard ⊂ Junction` | Yard owns provider selection ([yard-first-placement](./adr/yard-first-placement.md)) |
| **Control-plane occupancy (isolation)** | `Station` occupied by a `Conductor`, pinned by a `Rail` | Station owns Connections, Rails, identity, `station.*`/`rail.*`/`connection.*` event partition |

Station is **not** a fifth containment noun and never a parent of Yard. A Junction may federate Stations as members with signed trust/Rails/policy packs, but authority stays at the Station that owns the data; cross-Station Connection use fails closed without a federation grant (ADR-0131 §5).

**Disambiguation:** provider adapters expose `provisionTemporaryEnvironmentStation` (`hobo.temporary-environment-station/v1`) — a *temporary hosting endpoint*, not an ADR-0131 isolation boundary. When precision matters, say "temporary environment station" for the hosting endpoint and "Station" (capitalized) for the occupancy primitive.

## 2. Contracts and shapes

Owned by `@hobo/stations` ([package-namespaces](./package-namespaces.md)); wire forms in `packages/stations/data-models/station.proto` with CUE bounds in `station.cue`.

| Contract | Meaning |
|---|---|
| `hobo.station/v1` | `Station` declaration schema (the `station()` factory output) |
| `hobo.rail/v1` | Rail: Station-owned, content-addressed, versioned policy/engine/billing/delivery/connector profile |
| `hobo.control-plane-occupancy/v1` | The occupancy contract pinned on receipts (`stationId` + `railHash`) |
| `hobo.station-capability/v1` | One declared Station capability (ADR-0155, §4) |
| `hobo.station-capability-manifest/v1` | Audited match of a declared capability set against host evidence (ADR-0155, §5) |

The `station()` declaration is the SDK idiom (Station-as-Bindle when possible; `hobo station init` is the only non-Bindle seed):

```ts
import { station, stationCapability } from "@hobo/stations";

export const acme = station("acme-platform", {
  isolation: {
    tenant: "acme",
    residency: "us",
    trustDomain: "acme.hobo.local",
    isolationClass: "production", // ADR-0133: exactly one class, declared — never defaulted
  },
  rails: ["rail-prod"],
  capabilities: [
    stationCapability({ kind: "pam", slug: "gateway", title: "Privileged Access Gateway" }),
  ],
});
```

Two ADR-0133 formalization rules land here (previously drifting between doc and type):

- `isolationClass` is the **declaration's commitment**: `station()` passes it through verbatim and invents no default. An absent class stays absent and is visible as such.
- `residency` remains a free string on Stations pending the ADR-0146 normalization pass that Yards already received; treat Station residency strings as informational until then (tracked gap).

## 3. Occupancy lifecycle

Event-sourced under `HOBO_HOME/stations/<id>/events.jsonl`: `station.Created|Configured|Closed|IdentityRotated`, `rail.Published|Approved|Activated|Deactivated|Retired` ([event-families](./event-families.md)). `StationService` is the aggregate, `foldStationEvents` the pure projection, `StationClient` the read store; every Conductor resolve pins `stationId` + active `railHash`.

Context resolution (unchanged, [cli-spec](./cli-spec.md#station-context-resolution)): flags → env → `profile.defaultStation` → fail closed with remediation `hobo station init`. No silent durable auto-init (ADR-0131 §7).

## 4. Station capabilities (ADR-0155)

The design always spoke of Station capabilities informally — PAM is "an optional Station capability / Rail profile" (ADR-0133), Session Replay is "a default-supplied Station capability" (ADR-0137), dashboards/Evidence/evals are "Station sidecars". ADR-0155 gives that prose a type:

- A **StationCapability** (`hobo.station-capability/v1`) is a declared, schema-versioned facility a Station offers its occupants: `capability:<kind>:<slug>` over the closed kind vocabulary `runtime | vcs | isolation-backend | model-server | toolchain | harness | sidecar | pam | replay`.
- **Provenance** states where the claim comes from: `default` (default-supplied by the platform, present unless observed absent), `discovered` (claimed only from host evidence), `declared` (operator-declared, still requires evidence to match).
- **Required** capabilities gate explicit occupancy init; optional ones degrade with a remediation line.
- Declarations attach on the Station via `station(..., { capabilities })` — the capability set is part of the reviewable declaration, not runtime folklore.

## 5. Localhost capability matching

`@hobo/stations` matches a Station's declared capability set against host observations (`matchStationCapabilities`). The caller supplies the observations; the package decides what they prove.

- **Evidence is required**: every present row carries auditable evidence (`bin:/usr/bin/git`, `http:127.0.0.1:11434`, `matrix:linux-generic`).
- **Matching is fail-closed**: a declared `discovered` capability with no observation is missing — matching never assumes. A `default`-supplied row is present unless it is observed absent.
- **Required-missing is reported, not papered over**: the manifest's `ok` is false and `missingRequired` names each one, so a caller can refuse to seed durable Station state (ADR-0131 §7).
- Artifacts: the matched manifest lands at `HOBO_HOME/stations/<id>/capabilities.json` (`stationCapabilitiesPath`, discovery parallel of `sidecars.json`).

`hobo station init` (operator path) is unchanged.

## 5a. Rail `delivery` (HoBo.CD)

A Rail may carry an opaque `delivery` JSON object ([ADR-0180](./adr/01-architecture-core.md#adr-0180) D19–D25). It is part of
the Rail's canonical content and digest; `@hobo/stations` never interprets it,
and `@hobo/cd` parses it as `RailDeliveryRecord`:

| Field | Meaning |
|---|---|
| `camp_sets` | The Camp sets this Station may target. Placement sees only bound sets. |
| `max_fanout_camps` | The largest Placement decision a fan-out may run (default 1,000). |
| `failover` | `automatic` (default off), `max_concurrent`, `required_signals`, `allow_immediate_purge`. |
| `enrollment` | `separate_approvers` (the two enrollment grants come from different principals) and `auto_accept_scopes`. |
| `posture` | Posture packs with their remediation mode and evaluation intervals. |

Rails published before the field existed have no `delivery` and keep their
behavior. The neutral `deliveryPolicy` now names a reconciler mode
(`conductor`, `agent`, `publisher`) instead of an engine
([delivery-policy-upgrade.md](./delivery-policy-upgrade.md)). Rail versions
themselves are delivered as Freight ([continuous-delivery.md](./continuous-delivery.md)).

## 6. Open items

- **Federation** is still follow-on (ADR-0131 §5): fail-closed cross-Station denial is implemented; membership machinery is not designed.
- **Residency normalization** for Stations (ADR-0146 parity with Yards).
- **Bootstrap-active detection** in production posture has no named gate/event yet.
- **Requirements/traceability**: ADR-0131/0143/0155 still lack HOBO-* issue rows ("Linear import pending" in [traceability](./traceability.md)).
