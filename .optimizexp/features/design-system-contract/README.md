# Design system contract is agent-followable

Feature id: `design-system-contract`

## Seed

A designer or agent edits UI using implemented palette tokens and CSS; design lint (or equivalent) fails closed on contrast/token breaks with file references.

## Personas

Generated one Gherkin file per persona (explicit --personas):

- `design-system-contract-product-app-developer.feature` ← `.optimizexp/personas/product-app-developer.md`
- `design-system-contract-product-agent-operator.feature` ← `.optimizexp/personas/product-agent-operator.md`
- `design-system-contract-product-platform-engineer.feature` ← `.optimizexp/personas/product-platform-engineer.md`
- `design-system-contract-product-coding-agent.feature` ← `.optimizexp/personas/product-coding-agent.md`
- `design-system-contract-product-end-user.feature` ← `.optimizexp/personas/product-end-user.md`
- `design-system-contract-product-designer.feature` ← `.optimizexp/personas/product-designer.md`
- `design-system-contract-role-developers.feature` ← `.optimizexp/personas/role-developers.md`
- `design-system-contract-role-devsecops.feature` ← `.optimizexp/personas/role-devsecops.md`
- `design-system-contract-role-finops.feature` ← `.optimizexp/personas/role-finops.md`
- `design-system-contract-role-platform-engineers.feature` ← `.optimizexp/personas/role-platform-engineers.md`
- `design-system-contract-role-sre.feature` ← `.optimizexp/personas/role-sre.md`

## Bindings & tests

| Path | Role |
|---|---|
| `steps/bindings.steps.ts` | Cucumber Given/When/Then |
| `steps/implementations.ts` | Real command when discovered, else stub |
| `steps/discovery.json` | Code discovery report |
| `test/design-system-contract.bindings.test.ts` | Vitest smoke |

Re-discover / rewire: `generate-feature.mts --mode implement --id design-system-contract`

## Evidence

`evidence/<scenario-slug>/` — one primary recording per scenario; re-runs overwrite.

## Driver

`cli`
