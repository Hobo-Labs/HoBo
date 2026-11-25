# ADR: HOBO-555 Snapshop Launch Demo Storyboard Scope

## Status

Accepted for proof package.

## Context

The launch-demo work needs a refreshed `snapshop` storyboard and proof-mode
asset map before downstream launch-site, docs, recording, and support artifacts
can be trusted. HOBO-577 already accepted the resource-lifecycle quickstart
fixture ids and proof modes. HOBO-555 must consume those fixture ids instead of
inventing product behavior or implying live provider execution.

## Decision

HOBO-555 models the launch demo as a local experience proof backed by
protobuf, CUE, and Pact-style artifacts. The required storyboard steps are:

- scaffold,
- local run,
- inspect,
- plan,
- live recording slot,
- failure recovery, and
- support/docs handoff.

The asset map is explicit for screenshots, recording manifest, command
transcript, fixture data, and docs. Every asset carries a source, owner, refresh
trigger, validation route, stale downgrade behavior, and proof mode. The parser
fails closed when acceptance metadata is missing, scenario paths reference
unknown steps or assets, or storyboard steps drift away from accepted HOBO-577
quickstart fixtures. The required launch-demo fixture set is
`rlq-define-object-graph-v1`, `rlq-collect-manifest-ir-v1`,
`rlq-plan-safe-preview-v1`, `rlq-deploy-run-accepted-v1`,
`rlq-inspect-event-projection-v1`, `rlq-manage-stale-evidence-v1`,
`rlq-recover-snapshot-restore-v1`, and `rlq-recover-scope-out-v1`.

The package applies Parse, don't validate discipline at the fixture boundary.
Unknown JSON enters `parseVibeSnapshopLaunchDemoStoryboard` once and becomes a
parsed type before rendering summaries or downstream checks consume it.

The event architecture is named without implementing a runtime:

- **Command** - `RenderSnapshopLaunchDemoStoryboard` records an accepted demo
  storyboard fixture.
- **Event** - `SnapshopStoryboardStepPresented`,
  `SnapshopProofModeLabeled`, `SnapshopAssetFreshnessChecked`,
  `SnapshopRecordingSlotReserved`, and `SnapshopSupportHandoffRouted` append
  storyboard, proof-mode, freshness, recording-slot, and support-handoff
  evidence.
- **Actor** - `DemoMaintainerActor`, `DocsOwnerActor`,
  `LaunchAssetOwnerActor`, and `SupportHandoffActor` own the parsed fixture and
  reject final launch, credential, customer-data, provider, and proofless-claim
  creep.
- **Event store** - accepted storyboard evidence is replayable from HOBO-577
  quickstart fixture ids.
- **Materialized view / projection** - storyboard, asset-map, and scenario
  materialized views fold accepted events for downstream launch-site and docs
  consumers.
- **Snapshot** - the parsed HOBO-555 record is the replayable snapshot for
  storyboard, asset map, proof-mode, stale-downgrade, and support-handoff
  state.
- **Read store** - launch-demo consumers read the snapshot, not issue-body text
  or live provider state.

## Consequences

Downstream launch-demo, docs, support, and asset-refresh work can consume the
storyboard without importing unmerged production code. Future implementation
issues must replace fixture reads with real asset storage, recording manifests,
support workflows, and launch-publication gates under their own contracts.
