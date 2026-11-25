# Vibe first-run activation rail

This package proves `HOBO-540`: first-run activation rail mockups and a state model for Workspace &
Onboarding UX.

It is an experience proof, not production UI. It consumes the accepted resource lifecycle
quickstart fixtures from `HOBO-577` and maps them into onboarding states from invite or anonymous
try-it through workspace, project, plan preview, launch attempt, recovery, and value proof.

## Scope

In scope:

- persona entry wireframes for app developer, team admin, platform engineer, and support operator;
- state model rows with entry condition, exit condition, owner, evidence object, missing-prereq
  behavior, proof mode, and quickstart fixture ids;
- happy, blocked, stale-or-unknown evidence, and support handoff outcomes;
- proof-mode labels: live, simulated, reference fixture, and scope-out;
- TypeScript parser, protobuf schema, CUE constraints, and Pact-style fixture.

Out of scope:

- live provider calls;
- production UI;
- customer data;
- real credentials;
- launch claims without evidence.

## Contract anchors

- TypeScript parser: `src/vibe-first-run-activation-rail.ts`
- Protobuf: `architecture/vibe_first_run_activation_rail.proto`
- CUE constraints: `architecture/vibe_first_run_activation_rail.cue`
- Pact-style fixture: `architecture/pacts/vibe_first_run_activation_rail.pact.json`
- Design proof note: `docs/design/proofs/vibe-first-run-activation-rail/README.md`

Parse, don't validate: `parseVibeFirstRunActivationRail` is the single runtime boundary. Downstream
workspace, tutorial, plan/diff, dashboard, and support artifacts should consume the branded parsed
type instead of raw fixture objects.

## Event architecture

This proof does not implement runtime actors or persistence. It names the future boundary so
downstream work cannot invent it: commands such as `activation.SelectOutcome` and
`activation.OpenSupportHandoff` would emit events such as `activation.StageEntered`,
`activation.StageBlocked`, and `activation.ValueProofRecorded`. The onboarding actor owns those
events and writes them to the activation event-store. Query UX reads materialized views/projections
from cached snapshots in a read store; stale or unknown snapshots are blocked states, never green
success.

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ux/vibe-first-run-activation-rail test
```
