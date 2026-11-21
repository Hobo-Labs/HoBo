---
type: Agent Skill Reference
title: "OptimizeXP cognitive thresholds"
description: "Formal cognitive-load channels and per-persona thresholds that constrain delight experiments and feed harm metrics."
tags: [hobo, optimizexp, cognitive-load, clutter, feature-sprawl, hick, sweller, coga]
timestamp: 2026-07-31T00:00:00Z
---

# Cognitive thresholds

Personas do not only score harms/friction/uncertainty. They carry **cognitive thresholds**: budgets for how much complexity they tolerate before the experience **overwhelms**. Crossing a threshold:

1. **Raises** friction and/or uncertainty (and sometimes harms — e.g. unsafe defaults buried in sprawl)  
2. **Blocks** or **rejects** delight experiments that would add more load  
3. Can **decrease** excitement/ease/optimality past the inverted-U peak (`equilibrium.md`)

## Theory anchors (not re-derived ad hoc)

| Anchor | Application |
|---|---|
| **Cognitive load theory** (Sweller) | Separate *extraneous* load (clutter, poor IA) from *intrinsic* (task hardness). We measure extraneous-dominated channels. |
| **COGA / WCAG cognitive** | Working-memory limits, consistent patterns, minimize distractions |
| **Hick–Hyman law** | Decision time grows with choices → choice overload channel |
| **Visual search / set size** | Density of competing stimuli → visual clutter |
| **Feature creep / sprawl** | Surface area of concepts, flags, nav leaves |
| **Context switching** | Tool/agent/mode hops per job |

## Channels (0–5 **load**, lower better)

Score integers **0–5** per persona × surface (same scale as harm metrics).

| Channel | What is high load | Typical evidence |
|---|---|---|
| **featureSprawl** | Too many concepts, flags, scripts, nav leaves, skills, or parallel entrypoints for one job | Count of peer options; “which of these 12?” |
| **visualClutter** | Competing visual density, noise, decoration without hierarchy | Screenshots; visual token violations; dense dashboards |
| **interactiveClutter** | Too many controls, gestures, modes, or simultaneous affordances | Click maps; toolbar count; modal stacks |
| **choiceOverload** | Decision paralysis at a step (Hick) | Branching menus; multi-flag CLIs without progressive disclosure |
| **informationDensity** | Prose/logs/tables that exceed scannable chunking | Wall-of-text errors; unsummarized doctor output |
| **noveltyTax** | Unfamiliar metaphors, one-off vocabulary, unstable names | Glossary mismatch; renamed concepts mid-flow |
| **contextSwitchTax** | Forced hops across tools/agents/docs mid-task | “Open X then paste into Y then run Z” |
| **workingMemoryLoad** | Must hold >~4 chunks to complete the happy path | Multi-step without externalized state |
| **interruptionFragility** | Easy to lose place; weak resume | No success footer; no staged checkpoint |

## Score scale (load)

| Score | Meaning |
|---|---|
| 0 | Under budget; calm |
| 1 | Slight load; expert-ok |
| 2 | Noticeable; still within threshold for most |
| 3 | Heavy; near threshold for sensitive personas |
| 4 | Overwhelming for many; blocks common path |
| 5 | Severe overload; abandonment risk |

## Persona thresholds

Each persona declares **thresholds** (max acceptable load) per channel (default **3** if omitted):

```yaml
cognitiveThresholds:
  featureSprawl: 2          # juniors / end-users: lower
  visualClutter: 2
  interactiveClutter: 3
  choiceOverload: 2
  informationDensity: 3
  noveltyTax: 2
  contextSwitchTax: 2
  workingMemoryLoad: 2
  interruptionFragility: 3
```

**Breach** when `measured[channel] > threshold[channel]`.

### Suggested defaults by segment archetype

| Archetype | Lower thresholds (stricter) on |
|---|---|
| End-user / consumer | visualClutter, choiceOverload, noveltyTax |
| Junior engineer | featureSprawl, workingMemoryLoad, contextSwitchTax |
| Senior platform / SRE | informationDensity (tolerate more logs), but low interruptionFragility for pages |
| Coding agent (AX) | contextSwitchTax, noveltyTax, featureSprawl across skills |
| Designer | visualClutter, interactiveClutter (high sensitivity) |

## Formal scorecard field

Optional on bus `scores` (required in delight regime and whenever load is in play):

```json
"cognitive": {
  "featureSprawl": 1,
  "visualClutter": 0,
  "interactiveClutter": 1,
  "choiceOverload": 2,
  "informationDensity": 1,
  "noveltyTax": 1,
  "contextSwitchTax": 2,
  "workingMemoryLoad": 1,
  "interruptionFragility": 0,
  "total": 9,
  "max": 2,
  "breaches": []
}
```

`breaches` is a list of channel names where measured > persona threshold (computed at judge time; store for audit).

Helpers: `harness/lib/scorecard.mts` — `buildCognitive`, `validateCognitive`, `cognitiveBreaches(measured, thresholds)`.

## Mapping into primary metrics

| If cognitive high… | Prefer raising |
|---|---|
| featureSprawl, choiceOverload | friction (+ uncertainty if unlabeled options) |
| visual/interactive clutter | friction; harms if a11y/contrast buried |
| informationDensity | uncertainty (and friction) |
| noveltyTax | uncertainty |
| contextSwitchTax, workingMemoryLoad | friction |
| interruptionFragility | friction + uncertainty |

Do **not** double-count arbitrarily: primary scores remain the rollup; cognitive is the **diagnostic + constraint** layer (like HCD).

## Delight experiments must respect thresholds

Uplift that adds:

- another flag, skill, banner, animation, or parallel path → re-measure **featureSprawl** / **choiceOverload** / **visualClutter**  
- If breach → reject even if excitement briefly rises  

This is how the inverted-U is operationalized: **past-peak** feature additions show as cognitive↑ and delight↓ or constraint fail.

## Related

- [persona-models.md](persona-models.md) — thresholds live on personas  
- [equilibrium.md](equilibrium.md) — constraint in Pareto test  
- [metrics.md](metrics.md) — primary harm rollup  
