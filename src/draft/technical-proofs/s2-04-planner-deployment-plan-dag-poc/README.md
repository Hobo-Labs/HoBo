# S2-04 Planner DeploymentPlan DAG POC (HOBO-619)

Draft POC promoting the deterministic planner slice from
`src/draft/epic-proofs/control-plane-planner-matching-orchestrator/` into an
integrated manifest-IR → DeploymentPlan seam for S2 production work.

Linear: [HOBO-619](https://linear.app/quickdeploy-ai/issue/HOBO-619)

## Scope

- Consumes `hobo.manifest/v1` IR (planner annotations on resources).
- Builds a dependency DAG via `planner-dag-skeleton-contract`.
- Resolves ResourceDefinitions and capability `require`/`prefer` via
  `capability-negotiation-contract`.
- Emits `deployment.Planned` with per-resource rationale in plan `meta`.
- Emits `match.Decided` evidence per resolved resource.
- Fails closed with `deployment.PlanRejected` and a precise reason for
  unsatisfiable `require` (FR-032, `docs/design/control-plane.md` Plan 04).

Production promotion target: `packages/cloud/src/planner/` after S2-03 Yard
shell lands.

## Fixtures

| Fixture | Proves |
|---|---|
| `fixtures/hello-bindle.manifest.json` | hello-bindle plans deterministically |
| `fixtures/checkout-prod.manifest.json` | golden IR from control-plane epic |
| `fixtures/unsatisfiable-require.manifest.json` | seeded `require` rejection |
| `fixtures/golden/*.json` | byte-identical replay regression anchors |

## Run

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/s2-04-planner-deployment-plan-dag-poc
```

## Architecture Evidence

- `architecture/` — protobuf + CUE guard evidence
- `architecture/pacts/` — boundary PACT stub
- `ADR.md` — parse-don't-validate + event vocabulary

## Maintenance

Docs considered: this README is the maintenance note for the HOBO-619 draft POC.
Gates: package `test`, `architecture:guard`, `docs:freshness` (via this file).
