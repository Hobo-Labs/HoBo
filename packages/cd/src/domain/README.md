# `@hobo/cd/domain`

`@hobo/cd/domain` models continuous delivery promotions and multi-camp wave fanout on `@alchemy.run/domain` with branded Effect schemas (`CdPromotionId`, `CdFanoutId`, `CampTargetId`, `FreightDigest`, `ApproverId`, `RealizationRef`, `NonEmptyReason`, `NonNegativeCount`, `UniqueCampWave`) and discriminated tagged-union states:

- **Aggregates**: `CdPromotion` (`Idle | PendingApproval | Approved | Realized | Verified | Completed | RolledBack | Failed`) enforces strict approval, realization, verification, completion, and rollback transitions through typed command/event handlers; `CdFanout` (`Idle | Running | Completed | Halted`) enforces unique non-empty camp waves, rejects unknown or duplicate camp outcomes (`CampNotInWave`, `CampOutcomeAlreadyRecorded`), and halts automatically when the failure budget is exceeded.
- **Policy & Saga**: `StartCdPromotionPolicy` starts `ExecuteCdPromotion` when a promotion is approved (or auto-approved), coordinating `CdCampRealizer` and `CdVerificationGate` with fail-closed rollback compensation (a failed or unconfirmed rollback records `CdPromotionFailed` instead of `CdPromotionRolledBack`).
- **Views & API**: discriminated `CdPromotionStatusView`, `CdFanoutStatusView`, and `CdReleaseApi` expose materialized views and projections, snapshots, and read store queries over in-process and HTTP transports.

## Runbook

- **Promotion rejected with `RealizationRequiredBeforeVerify` or `RollbackRequiresRealization`**: verify the promotion state in `CdPromotionStatusView` before issuing verification or rollback commands.
- **Fanout rejected with `CampNotInWave` or `CampOutcomeAlreadyRecorded`**: check the wave's `campIds` from `CdFanoutStarted`; each camp target may report an outcome at most once.
