# `@hobo/cd/domain`

`@hobo/cd/domain` models continuous delivery promotions and multi-camp wave fanout on `@alchemy.run/domain`:

- **Aggregates**: `CdPromotion` enforces approval, realization, verification, completion, and rollback transitions; `CdFanout` tracks wave outcomes and halts automatically when the failure budget is exceeded.
- **Policy & Saga**: `StartCdPromotionPolicy` starts `ExecuteCdPromotion` when a promotion is approved (or auto-approved), coordinating `CdCampRealizer` and `CdVerificationGate` with automatic rollback compensation on verification failure.
- **Views & API**: `CdPromotionStatusView`, `CdFanoutStatusView`, and `CdReleaseApi`.
