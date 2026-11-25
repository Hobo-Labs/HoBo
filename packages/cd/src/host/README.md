# `@hobo/cd/host`

`@hobo/cd/host` composes `@hobo/cd/domain` (`CdRelease`) onto portable runtime platforms outside `src/domain/`:

- **Rivet Durable Objects**: `createCdReleaseRivetLayer` hosts every `CdPromotion`, `CdFanout`, view, policy, and saga instance on `@alchemy.run/domain/Rivet` (`DomainRivet.layerDurableObjects`) with per-actor SQLite event store and alarm scheduling.
- **RivetKit Promotion Gate Actor**: `createCdPromotionGateRegistry` defines the `promotionGate` RivetKit actor backed by embedded SQLite, live `gateUpdated` broadcasts, and scheduled deadline expiry.
- **Portable Hosts**: `createCdReleaseInMemoryLayer` (`Domain.InMemory`) and `createCdReleaseSqliteLayer` (`@hobo/storage-sqlite` `createSqliteDomainPlatform`) serve identical command/event, snapshot, and materialized view behavior in-process and over HTTP (`Domain.protocolHttp`).

## Typed Failures

External system layers supplied to the host factories surface `CampRealizationFailed` and `VerificationGateFailed`; any schema drift across external boundaries fails closed with `ExternalSystemSchemaError`.

## Runbook

- **Rollback failed (`rollback-failed:*` or `rollback-unconfirmed:*`)**: `ExecuteCdPromotion` fails closed into `CdPromotionFailed` rather than marking the promotion rolled back. Inspect the camp realization reference, verify live camp state, and execute a compensating rollback Delta before retrying.
- **RivetKit gate stuck in `pending`**: inspect `listGates()` on the `promotionGate` actor and verify the Rivet engine alarm worker is healthy; once the deadline elapses, `expireGate` transitions the gate to `expired` fail-closed.
