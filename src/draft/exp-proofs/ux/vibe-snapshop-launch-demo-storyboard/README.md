# Vibe Snapshop Launch Demo Storyboard

This proof package satisfies HOBO-555 with a deterministic `snapshop` launch
demo storyboard and proof-mode asset map. It stays inside
`src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard` and does not build
a launch marketing page, produce the final demo video, provision providers,
store credentials, use customer data, or publish launch claims without
evidence.

## Proof

- `src/vibe-snapshop-launch-demo-storyboard.ts` parses the storyboard bundle,
  asset map, quickstart fixture references, scenarios, and scope guards.
- `test/vibe-snapshop-launch-demo-storyboard.test.ts` proves the accepted
  storyboard steps, assets, proof modes, scenario coverage, accessibility
  notes, exact HOBO-577 fixture reuse, and scope-out behavior.
- `architecture/proto/vibe_snapshop_launch_demo_storyboard.proto` defines the
  boundary messages first.
- `architecture/vibe_snapshop_launch_demo_storyboard.cue` pins required fields,
  proof modes, scenario references, and asset-map invariants.
- `architecture/pacts/vibe_snapshop_launch_demo_storyboard.pact.json` gives
  launch-site/docs consumers a Pact-style response without importing production
  runtime code.

Run the focused proof:

```bash
pnpm --dir src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard test
```

## Design Alignment

- `docs/design/launch-demo-golden-path.md`: reuses the accepted snapshop
  scaffold, local run, inspect, plan, live recording slot, and failure recovery
  command path.
- `docs/design/launch-messaging-claims.md`: keeps public claims blocked unless
  live evidence exists in the recording manifest.
- `docs/design/known-limitations-register.md`: routes stale, simulated,
  unsupported, and reference-fixture states through limitation wording.
- HOBO-577: consumes accepted quickstart fixture ids and proof-mode labels
  before creating launch-demo assets. The fixture set is
  `rlq-define-object-graph-v1`, `rlq-collect-manifest-ir-v1`,
  `rlq-plan-safe-preview-v1`, `rlq-deploy-run-accepted-v1`,
  `rlq-inspect-event-projection-v1`, `rlq-manage-stale-evidence-v1`,
  `rlq-recover-snapshot-restore-v1`, and `rlq-recover-scope-out-v1`.

## Audience And Friction

The storyboard serves app developer evaluators, platform engineer evaluators,
agent builders, demo maintainers, docs owners, launch owners, and support
operators. It reduces ambiguity around which parts of the demo are live,
simulated, reference fixtures, or scope-out, and who owns stale evidence or
blocked recovery states.

## Scope Guards

`classifySnapshopStoryboardRequest` rejects final launch marketing pages, final
demo videos, live provider provisioning, provider credentials, customer data,
public launch claims without evidence, production launch work, and real-cloud
execution.
