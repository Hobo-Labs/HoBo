---
layout: ../../layouts/Docs.astro
title: Contracts & PACT
description: "Executable consumer-driven contracts: project layout, subset matching, inventory drift, and how PACT sits under Contract IR."
---

# Contracts & PACT

Every service boundary owns **executable contracts**. HoBo’s source of truth is the **Contract IR** (`BoundaryContract`). PACT documents are the common **export/import shape** and the local test harness format — not a parallel product model.

## Project layout

```text
your-app/
  contracts/
    inventory.md
    pacts/<boundary>.pact.json
    consumer/<boundary>.contract.test.ts
    provider/<boundary>.provider.test.ts
    provider/fixtures/
```

Inventory columns track boundary → consumer → provider → protocol → status (`consumer_tested` → `provider_verified`).

## Consumer and provider

1. **Consumer tests** generate or refresh the pact document against expected interactions.
2. **Provider verification** replays interactions against the real implementation with **subset matching**: the expected response must be a subset of actual, so providers may grow fields without breaking consumers.
3. The same interactions feed **[Bridge](/HoBo/troubleshooting/bridge/)** activation: a local fork must pass the BoundaryContract before carrying traffic.

## Harness

The contract harness parses pact documents, builds in-process consumer mocks, runs provider verification, and gates inventory drift (declared boundaries must match files on disk).

## Contract IR vs PACT

- **Contract IR** — versioned producer/consumer edge + shape + optional **EffectSpec** / **ResilienceProfile**; feeds can-deploy and Gatekeeper.
- **PACT** — interaction-level request/response evidence for a boundary implementation.
- Developers usually never “turn PACT on”; it is the harness detail under the contract engine.

## Compatibility gates

`can-deploy` / Gatekeeper answer version-skew: *will this next revision still satisfy deployed consumers?* Removed required fields and (when declared) **effect widening** are breaking. See [Reference: contracts](/HoBo/reference/contracts/).

## Next

- [Effect-aware isolation](/HoBo/testing/effects/)
- [Deployment rehearsal](/HoBo/testing/deployment/)
