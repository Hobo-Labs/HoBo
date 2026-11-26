# @hobo/stations — Architecture Evidence

Station is the **control-plane occupancy primitive**: the durable isolation-bound
environment a Broker (Conductor) occupies. It is **not** app-topology containment
(Bindle ⊂ Camp ⊂ Yard ⊂ Junction).

## Schema and constraints

- Protobuf records live in [`data-models/station.proto`](./data-models/station.proto).
- CUE constraints bound every protobuf type in [`data-models/station.cue`](./data-models/station.cue).
- PACT consumer evidence lives under [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

Untrusted Station / Rail input crosses parser boundaries in `station()`,
`createRail()`, and `initStation()` into deep-frozen derived domain types
(`Station`, `Rail`, `StationOccupancy`). Downstream Conductors receive those
parsed types, not raw config objects.

## Event architecture

- **Command** — `station init`, rail publish/approve/activate, close Station.
- **Event** — `station.Created` / `Configured` / `Closed` / `IdentityRotated`,
  `rail.Published` / `Approved` / `Activated` / `Deactivated` / `Retired`.
- **Actor** — `StationService` owns the Station aggregate and Rail catalog.
- **Event store** — Station partition under `HOBO_HOME/stations/<id>/events.jsonl`.
- **Materialized view / projection** — pure `foldStationEvents` rebuild-from-zero.
- **Snapshot** — occupancy + rails map is the projection snapshot.
- **Read store** — `StationClient` serves occupancy, active Rail, and receipt pins
  (`stationId`, `railHash`) without replaying when folded once.

## Layering

Stations depend inward on `@hobo/core` (ports/envelopes), `@hobo/connectivity` (endpoint/routing shapes), and `@hobo/dispatcher` (budget-aware ranking for the routing control loop). Identity Connections attach `stationId`;
Broker mounts a Station client as pure Conductor (no durable Connection store).

## Routing effects and restart boundary

Routing depends on `@hobo/contracts` for the canonical effect and resilience
models. The control loop emits decisions and persists a generated routing snapshot
before actuator writes; it never treats replay as permission to repeat an external
effect. The hosting supervisor supplies fenced snapshot persistence and financial
admission through `beforeApply`; an unresolved provider outcome blocks subsequent
routing until observation or saga recovery establishes the result.

The routing actuator cannot retire hosting resources or settle a provider bill.
That distinction is explicit in the hosting supervisor contract. Cutover preserves
availability/resiliency across every phase and reports confirmed restoration
separately from reconciliation-required. Schema source is `data-models/`; `buf.yaml`
opts this package into generated runtime records and drift checking.
