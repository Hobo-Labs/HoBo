---
layout: ../../layouts/Docs.astro
title: Effect-aware isolation
description: "Use EffectSpec so pure contracts unit-test with zero infra, domain effects drive automatic mocks, and ResilienceProfile guides never-retry fault injection."
---

# Effect-aware isolation

This is one of the patterns that feels unfamiliar if you came from “hand-roll mocks.” HoBo puts **side-effect intent on the contract**. Tests read that metadata and choose isolation automatically.

## EffectSpec in one minute

A `BoundaryContract` may declare:

| Axis | Examples |
|---|---|
| **Purity** | `pure` → `varies` → `transacts` → `noRollback` |
| **Capabilities** | `decides`, `suspends`, `allocates`, `concurrent` |
| **Domains** | `network`, `storage`, `identity`, `policyEval`, `eventEmit`, `clock`, `agentTool`, … |

- Composition is **union** of callee effects.
- **Subtyping:** safer (fewer/purer) effects may be used where more effects are expected.
- **Widening** (pure → network, etc.) is a **breaking** can-deploy reason when effects are declared.

## Harness modes

```ts
import { createBoundaryContract, pureEffects } from "hobo/contracts";
import { createEffectIsolation } from "hobo/testing";

const pure = createBoundaryContract({
  id: "pure-math",
  effects: pureEffects(),
});
createEffectIsolation(pure);
// → isolationMode: "zero-infra", mocks: []

const net = createBoundaryContract({
  effects: {
    purity: "varies",
    capabilities: ["decides", "suspends"],
    domains: ["network", "externalCall"],
  },
});
createEffectIsolation(net);
// → isolationMode: "domain-mocked", mocks per domain
```

| Isolation mode | When |
|---|---|
| `zero-infra` | Pure contracts |
| `domain-mocked` | Domain I/O declared |
| `conservative` | Unknown / no usable domains |

## Resilience fault injection

Attach a **ResilienceProfile** (secondary metadata — not a new top-level primitive):

- Deterministic retry schedules (stable seed + budget + attempt facts).
- **Never** retry `policy.Decided` deny, terminal failures, or cancellation.
- Inspection is reconstructed from **facts**, not process memory.

```ts
// Fault-injection harness: one policy deny, no blind retries
await runResilienceFaultInjection({
  contract: netWithProfile,
  failures: [{ attempt: 1, failureClass: "policy.Decided", message: "deny" }],
});
// attempts === 1 — policy denies are never retried
```

## Capture without re-execution

Effect capture records `contract.EffectDeclared` / `contract.EffectInvoked`. Replay **inspects those facts** — it does not re-invoke handlers. That matches the product rule: inspection is event-sourced.

## Export

CLI and MCP can describe a contract or export an effect manifest for policy and SRE tooling.

## Next

- [Reference: effects](/HoBo/reference/effects/)
- [Durable EventStore tests](/HoBo/testing/durability/)
