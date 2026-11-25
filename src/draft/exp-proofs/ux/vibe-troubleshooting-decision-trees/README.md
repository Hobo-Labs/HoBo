# Vibe Troubleshooting Decision Trees

HOBO-553 proof for diagnostic decision trees across install, auth, plan, deploy,
policy, stale evidence, unsupported requests, and support handoff paths.

## What This Proves

- Decision tree records carry symptom, diagnostic command or evidence, likely
  owner, safe next action, customer-safe wording, and escalation route.
- Fixtures cover install failure, missing auth/SVID, blocked plan, deploy
  failure, policy denial, stale evidence, unsupported request, happy path, and
  support handoff states.
- Downstream troubleshooting material consumes accepted HOBO-577 quickstart
  fixture ids and proof-mode labels instead of inventing product behavior.
- Redaction and customer-safe wording are required before support handoff.
- Scope guards reject diagnostic automation, support queues, live repair,
  customer data, unredacted logs, and unsupported launch claims.

## Boundary

This is an experience proof. It does not build production docs, support queues,
ticket routing, runtime remediation, provider repair, customer-data handling, or
launch claims without evidence.

## Contract Anchors

- Protobuf: `architecture/vibe_troubleshooting_decision_trees.proto`
- CUE constraints: `architecture/vibe_troubleshooting_decision_trees.cue`
- Pact-style fixture: `architecture/pacts/vibe_troubleshooting_decision_trees.pact.json`
- Executable acceptance: `test/vibe-troubleshooting-decision-trees.test.ts`
- Design proof note: `docs/design/proofs/vibe-troubleshooting-decision-trees/README.md`

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-troubleshooting-decision-trees test
```

The workspace lockfile importer list is kept current with this proof package and
recently landed sibling vibe proof packages so `pnpm install --frozen-lockfile`
stays clean after rebasing on `origin/main`.

## Architecture Evidence

- Parse, don't validate: raw fixture input parses once into the derived domain
  type `ParsedVibeTroubleshootingDecisionTrees`.
- `ADR.md` names the troubleshooting command family, event family,
  `TroubleshootingGuideActor`, fixture event-store stream,
  `TroubleshootingGuideProjection` materialized view / projection, read store
  snapshots, and downstream consumers.
