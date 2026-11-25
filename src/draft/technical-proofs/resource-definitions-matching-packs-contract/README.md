# HOBO-641 Resource Definitions + Matching + Resource Packs Contract

S4-05 draft POC integrating the platform-engineering surface from
[Plan 25](../../../../docs/design/platform-engineering.md#plan-25):

- **Resource Definitions + Matching** — specificity-scored selection with `match.Decided` evidence
- **Deployment Sets + Deltas** — draft→promote via `delta.Applied` producing immutable content-addressed Sets
- **Resource Packs** — `hobo add` installs pack definitions into the Yard catalog for Matching

Promotes Matching/Set/Delta scenarios from
[`control-plane-planner-matching-orchestrator`](../../epic-proofs/control-plane-planner-matching-orchestrator/README.md).

## Acceptance (BDD)

```gherkin
Feature: Resource definition matching

  Scenario: Specificity-scored winner with auditable evidence
    Given a catalog with catch-all, env, and app-specific definitions
    When Matching runs for a production shop database
    Then the most specific definition wins with score 3
    And a valid match.Decided event is emitted

Feature: Deployment Set promotion

  Scenario: Delta promotes to immutable Set
    Given a base Deployment Set for prod-aws
    When a Delta updates api, removes cache, and adds worker
    Then delta.Applied yields an immutable Set with stable content address
    And incremental reconcile targets only changed nodes

Feature: Multi-cloud shop planning

  Scenario: Installed packs participate in per-Camp matching
    Given AWS and Azure Resource Packs installed on a Yard
    When planning shop.db and shop.api across prod-aws and prod-azure
    Then each Camp selects its provider's shop-specific definitions
```

## Run

```bash
pnpm --prefix src/draft/technical-proofs/resource-definitions-matching-packs-contract test
```

## Dependencies (draft contracts)

- `matching-engine-skeleton-contract` — `decideResourceDefinition`, `matchingDecisionToEvent`
- `resource-pack-distribution-contract` — `hoboAddResourcePack`, pack verification
- `resource-definition-driver-contract` — `createResourceCatalog`
- `hobo-50-deployment-set-delta` — `foldDeploymentProjections`, `contentAddressDeploymentSet`

## Architecture Evidence

- `architecture/` — protobuf + CUE + PACT boundary evidence
- `ADR.md` — parse-don't-validate and event-driven Set/Delta notes

## Scope (out)

Production `packages/` implementation, Gatekeeper promote/rollback sagas, live Registry,
and S4-04 mapping-style Planner prefer/require resolution remain outside this POC.
