---
type: Reference
title: "HOBO-572 DX Resource Lifecycle Fixture Corpus Proof"
description: "Source issue: HOBO-572."
tags: [hobo, design]
---

# HOBO-572 DX Resource Lifecycle Fixture Corpus Proof

HOBO-572 is proven by the focused experience proof at
[`src/draft/exp-proofs/dx/dx-resource-lifecycle-fixture-corpus`](../../../../src/draft/exp-proofs/dx/dx-resource-lifecycle-fixture-corpus/README.md).

## Acceptance Evidence

- The corpus includes deploy, manage, migrate, rollback, import/adopt, drift,
  stale projection, policy denial, contract incompatibility, and support
  evidence paths.
- Every scenario names resources, links, manifest IR, DeploymentPlan,
  Deployment Set, Delta, Gatekeeper decision, ResourceActor events, projection,
  and log artifacts.
- Every scenario carries concrete `dx.lifecycle.<scenario>.<fact-kind>.v1`
  fixture facts for those artifacts plus drift reports, import/adopt state,
  migration phases, and support evidence, all sourced from the shared corpus.
- Fixtures are deterministic, redacted, tenant-safe, and labeled as
  `reference fixture` unless explicit live or simulated evidence is present.
- Protobuf, CUE, Pact, fixture JSON, and type-consumer expectations are named as
  downstream boundary contracts.
- SDK compile consumers, CLI transcript generators, control-plane API examples,
  docs snippets, and later visual mockups consume the same domain facts.

## Negative Coverage

- Validation rejects missing lifecycle scenarios.
- Validation rejects scenarios that omit shared fixture facts.
- Validation rejects non-deterministic, unredacted, or non-tenant-safe fixture
  entries.
- Validation rejects `live` proof mode without explicit live evidence.
- Validation rejects live provider, customer data, real secret, production
  catalog, cloud credential, and one-off mockup fixture scope creep.

## Verification

```powershell
pnpm --prefix src\draft\exp-proofs\dx-resource-lifecycle-fixture-corpus test
pnpm run architecture:guard
pnpm run docs:design-lint
pnpm run check:relevant:staged
```
