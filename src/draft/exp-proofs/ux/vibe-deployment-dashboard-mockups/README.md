# Vibe Deployment Dashboard Mockups

Independent M1 proof for HOBO-544.

This package records projection-backed mockup and wireframe contracts for the
deployment timeline, topology graph, run inspector, project/environment fleet,
and health/cost/incident rollups. The proof covers the operator, developer,
release, support, and security reviewer questions without building a production
dashboard, graph renderer, projection engine, GraphQL facade, live provider
traversal, RBAC runtime, or launch claim.

## Contract Boundaries

- In scope: mockup records, wireframe questions, field-group fixture metadata,
  scenario paths, proof-mode labels, accessibility notes, and scope-out guards.
- Quickstart dependency: dashboard surfaces cite HOBO-577 quickstart fixture ids
  `rlq-deploy-run-accepted-v1`, `rlq-inspect-event-projection-v1`,
  `rlq-manage-stale-evidence-v1`, `rlq-recover-snapshot-restore-v1`, and
  `rlq-recover-scope-out-v1` with their accepted proof-mode labels.
- Consumed but not owned: `DeploymentView`, `TopologyView`, `RunView`,
  `ProjectView`, `EnvironmentView`, `AvailabilityView`, cost signals, incident
  signals, tenant/RBAC decisions, and support handoff runbooks.
- Out of scope: production dashboard frontend, visual graph renderer,
  projection/read-store/GraphQL runtime, live provider traversal, RBAC
  implementation, and unsupported launch readiness claims.

## Proof

```powershell
npm.cmd --prefix src\draft\exp-proofs\vibe-deployment-dashboard-mockups test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Mockups cover all required personas. | `wireframes` map platform operator, application developer, release owner, support engineer, and security reviewer to operating questions. |
| Fixtures disclose source, freshness, owner, tenant/RBAC disposition, safe action, and proof mode. | `fieldGroups` carry projection source, freshness, owner, RBAC disposition, safe next action, and proof mode. |
| Target package and proof paths are pinned. | `parseVibeDeploymentDashboardMockups` rejects path drift. |
| Happy, blocked, stale/unknown, support handoff, accessibility, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each acceptance state. |
| Downstream dashboard mockups consume the accepted HOBO-577 quickstart fixtures. | `quickstartFixtureRefs` pins the source issue, accepted fixture ids, proof-mode labels, consuming surfaces, and dashboard-use notes. |
| Scope out remains hard. | `classifyDashboardMockupRequest` rejects production UI, graph renderer, projection runtime, GraphQL, live provider, RBAC, and proofless launch requests. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the mockup
  record.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
