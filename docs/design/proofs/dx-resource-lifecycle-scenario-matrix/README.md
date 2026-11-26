---
type: Reference
title: "DX Resource Lifecycle Scenario Matrix Proof"
description: "Source issue: HOBO-567."
tags: [hobo, design]
---

# DX resource lifecycle scenario matrix proof

`HOBO-567` creates the canonical resource lifecycle DX matrix for the HoBo
greenfield design. The executable proof lives in
`src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix`.

## Acceptance evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Matrix covers app developer, platform engineer, GitOps, SecOps, DevOps, SRE, and agent/MCP caller journeys. | `REQUIRED_ROLES` and the parser enforce one row for every required role. |
| Each journey names commands, SDK calls, API calls, MCP tools, artifacts, proof mode, and fixture requirements. | `dx-resource-lifecycle-scenario-matrix.test.ts` asserts every journey has all executable touchpoints. |
| Includes happy path, blocked path, stale/unknown evidence path, migration/rollback path, and support handoff. | `REQUIRED_SCENARIO_PATHS` is asserted for every journey. |
| References existing HoBo commands and resource lifecycle concepts. | `REQUIRED_DESIGN_TERMS` pins `hobo up`, `hobo plan`, `hobo collect`, `hobo inspect`, `hobo logs`, `hobo doctor`, `hobo import terraform`, `DeploymentPlan`, `Deployment Set`, `Delta`, `Gatekeeper`, `ResourceActor`, and `migration.*`. |
| Scope-out remains outside the proof. | `classifyDxScenarioScope` rejects production implementation, live provider/credential, customer-data, and premature visual-behavior proposals. |

## Design references

- [`developer-experience.md`](../../developer-experience.md#plan-07)
- [`cli-spec.md`](../../cli-spec.md)
- [`control-plane.md`](../../control-plane.md#plan-04)
- [`platform-engineering.md`](../../platform-engineering.md#plan-25)
- [`authoring-resources-wiring.md`](../../authoring-resources-wiring.md#plan-21)
- [`contracts-policy-flags.md`](../../contracts-policy-flags.md#plan-29)
- [`data-plane.md`](../../data-plane.md#plan-11)
- [`walkthrough.md`](../../walkthrough.md)
- [`worked-example.md`](../../worked-example.md)

## Verification

```bash
pnpm run test:file src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix/test/dx-resource-lifecycle-scenario-matrix.test.ts
```

Architecture and boundary artifacts:

- Protobuf: `src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix/architecture/dx_resource_lifecycle_scenario_matrix.proto`
- CUE: `src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix/architecture/dx_resource_lifecycle_scenario_matrix.cue`
- Pact-style fixture: `src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix/architecture/pacts/dx_resource_lifecycle_scenario_matrix.pact.json`
