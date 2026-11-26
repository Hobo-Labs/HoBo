---
layout: ../../layouts/Docs.astro
title: Effects & resiliency
description: "EffectSpec purity lattice, domain effects, EffectManifest capture, and secondary ResilienceProfile application rules."
---

# Effects & resiliency

. Names are locked: **Effects** on contracts; **Resiliency** as secondary visible layer. 

## EffectSpec

```ts
interface EffectSpec {
 schemaVersion: "hobo.effect-spec/v1";
 purity: "pure" | "varies" | "transacts" | "noRollback";
 capabilities: ("decides" | "suspends" | "allocates" | "concurrent")[];
 domains: (
 | "network" | "storage" | "identity" | "policyEval" | "eventEmit"
 | "metering" | "overlayTunnel" | "iac" | "secretsResidual" | "clock"
 | "externalCall" | "agentTool"
 )[];
}
```

### Lattice helpers

| Helper | Meaning |
|---|---|
| `isPure` | No domain I/O; purity pure |
| `mayFail` | Has `decides` |
| `requiresNetwork` | `network` or `externalCall` |
| `effectUnion` | Join purity + union sets |
| `effectSubtype` | Safer provided ⊆ required |
| `isEffectWideningBreaking` | Next adds domains/caps or dirties purity |

### Defaults

Missing effects are valid (opt-in). External reasoning applies a **conservative** default (`noRollback` + `decides` + network/externalCall) without rewriting the content hash of contracts that omitted effects.

## Capture

| Fact | When |
|---|---|
| `contract.EffectDeclared` | Contract effects registered |
| `contract.EffectInvoked` | Boundary invocation recorded |

Effect capture writes to an event sink. Replay **reads facts** — does not re-execute handlers.

Effect manifests export purity, domains, and flags (`mayFail`, `requiresNetwork`, `isPure`) for CLI, MCP, policy, and SRE tooling.

## ResilienceProfile (secondary)

Strategies (metadata + thin applicator):

- `retry` — deterministic seed, max attempts, delays; `retryOn: "transient-only"`
- `circuitBreaker`, `timeout`, `bulkhead`, `fallback`, `hedging`

Always enforce **neverRetry**: `policy.Decided`, `terminal`, `cancellation`.

Applying a profile emits `resilience.Attempt` / `resilience.Terminal`. Inspection rebuilds terminal state from those facts without re-running ops.

Circuit-breaker / hedging require network/externalCall domains on the contract.

## Testing entry

[Effect-aware isolation](/HoBo/testing/effects/)
