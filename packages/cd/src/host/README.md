# `@hobo/cd/host`

`@hobo/cd/host` composes `@hobo/cd/domain` (`CdRelease`) onto portable runtime platforms outside `src/domain/`:

- **Rivet Durable Objects**: `createCdReleaseRivetLayer` hosts every `CdFreight`, `CdStage`, `CdDeliveryRun`, `CdPromotion`, `CdFanout`, view, policy, and saga instance on `@alchemy.run/domain/Rivet` (`DomainRivet.layerDurableObjects`) with per-actor SQLite event store and alarm scheduling.
- **Pluggable CD Flow Router**: `createCdDeliveryFlowRouterLayer` dispatches `CdDeliveryFlow` operations by `DeliveryFlowTarget` across pluggable delivery adapters (such as GitOps pull engines, outbound agents, or release orchestrators) and fails closed with `UnsupportedDeliveryFlow` for unregistered targets.
- **RivetKit Promotion Gate & Pull Watch Actors**: `createCdPromotionGateRegistry` defines the `promotionGate` RivetKit actor, and `createCdPullWatchRegistry` defines the `pullWatch` RivetKit actor backed by embedded SQLite, live `pullWatchUpdated` broadcasts, schema-decoded RPC inputs, and scheduled deadline expiry for open pull requests and awaiting pull-engine convergence.
- **Portable Hosts**: `createCdReleaseInMemoryLayer` (`Domain.InMemory`) and `createCdReleaseSqliteLayer` (`@hobo/storage-sqlite` `createSqliteDomainPlatform`) serve identical command/event, snapshot, and materialized view behavior in-process and over HTTP (`Domain.protocolHttp`).

## Typed Failures

External system layers supplied to the host factories surface `CampRealizationFailed`, `VerificationGateFailed`, `DeliveryFlowFailed`, and `UnsupportedDeliveryFlow`; any schema drift across external boundaries fails closed with `ExternalSystemSchemaError`.

## Runbook

- **Rollback failed (`rollback-failed:*` or `rollback-unconfirmed:*`)**: `ExecuteCdPromotion` and `ExecuteCdDeliveryFlow` fail closed into `CdPromotionFailed` / `DeliveryRunFailed` rather than marking the release rolled back. Inspect live target state and execute a compensating rollback Delta before retrying.
- **RivetKit gate or pull watch stuck in `pending` / `watching`**: inspect `listGates()` on `promotionGate` or `listWatches()` on `pullWatch` and verify the Rivet engine alarm worker is healthy; once the deadline elapses, `expireGate` / `expireWatch` transitions the entry fail-closed.
