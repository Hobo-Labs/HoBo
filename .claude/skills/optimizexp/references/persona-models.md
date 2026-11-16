---
type: Agent Skill Reference
title: "OptimizeXP persona KYC models"
description: "Formal demographic and psychographic persona models, market segments, and cognitive thresholds for multi-segment delight measurement."
tags: [hobo, optimizexp, personas, kyc, psychographics, segmentation, jtbd]
timestamp: 2026-07-31T00:00:00Z
---

# Persona models (KYC-lite, synthetic)

Personas are **judgment instruments**, not legal customers. We still require a **formal, research-grade profile** so delight metrics reflect **intended market segments**, not a single generic engineer.

Standards drawn from:

| Source | Use |
|---|---|
| **Cooper / Goodwin personas** | Goals, behaviors, scenarios — not marketing slogans |
| **JTBD (Christensen / Ulwick)** | Job stories over feature lists |
| **Market segmentation** | Demographic + psychographic + behavioral + needs-based slices |
| **“KYC” metaphor** | Know-Your-Customer style **structured attributes** — **synthetic only**, never real PII |
| **Inclusive design** | Accessibility needs explicit; no stereotype harm |

**Never** store real names, emails, national IDs, health data, or exact home addresses in persona files.

## schemaVersion

Persona frontmatter **`schemaVersion: 2`** adds formal models below.  
`schemaVersion: 1` remains valid for grandfathered files; **new/rewritten** personas must be **v2**. Init and `--persona` generation produce v2.

## Frontmatter (v2)

```yaml
---
id: product-app-developer
schemaVersion: 2
experiences: [dx, ax]   # REQUIRED formal binding — see below
priority: 10
interfaces: [cli, docs, mcp, config]
generatedFromSeed: false
seedDigest: null
segmentIds: [indie-fullstack, dx-primary]
marketPriority: 1
---
```

| Field | Required (v2) | Meaning |
|---|---|---|
| **`experiences`** | **yes** | **Experience-type binding** — non-empty subset of `ux` \| `dx` \| `ax` (multi ok). Alias: `experienceTypes`. |
| `segmentIds` | yes | One or more market segment tags this persona represents |
| `marketPriority` | no | Lower = more important for coverage when time-boxing |

### Experience-type binding (`experiences`)

Closed enum: **`ux`**, **`dx`**, **`ax`**. One or more values. Harness code: `harness/lib/experience-types.mts`.

| Run flag | Selects personas with |
|---|---|
| `--ux` | `ux` ∈ experiences |
| `--dx` | `dx` ∈ experiences |
| `--ax` | `ax` ∈ experiences |
| (default all) | any of ux/dx/ax |

Intersection is **strict** — no silent fall-through to all personas. See `personas.md` § Formal field.

## Required body models (v2)

### 1. Segment & job (JTBD)

```markdown
## Market segment
- segmentIds: indie-fullstack
- primary job: ship a Bindle-shaped app without learning the whole monorepo
- secondary jobs: …
- non-jobs (out of scope for this persona): …
```

### 2. Demographic model (synthetic)

Structured, **category-level** only:

```markdown
## Demographic model
- roleFamily: application-developer | platform | design | end-user | agent-operator | finops | sre | other
- seniority: junior | mid | senior | principal | student | hobbyist
- orgArchetype: solo | startup | smb | enterprise | oss-community | agency
- domainFamiliarity: new-to-hobo | migrating | power-user
- localeContext: en-primary | i18n-sensitive | rtl-sensitive   # not a real address
- deviceContext: desktop-first | mobile-first | mixed
- timeBudget: minutes | hours | multi-day
- accessibilityProfile: none-declared | prefers-reduced-motion | screen-reader-possible | cognitive-load-sensitive
```

Rules:

- Use **enums / buckets**, not precise age or income numbers unless a public segment definition needs a band (e.g. `budget: free-tier`).  
- Diversity: the **set of personas** in the repo should cover multiple roleFamily × seniority × orgArchetype cells for the product’s intended market — not twelve clones of “senior TS dev.”

### 3. Psychographic model

```markdown
## Psychographic model
- values: [clarity, speed, autonomy, safety, craft, cost-control, …]
- riskTolerance: low | medium | high
- noveltySeeking: low | medium | high          # maps to noveltyTax threshold
- trustInAutomation: low | medium | high       # critical for AX
- documentationPreference: examples-first | reference-first | video-first
- errorEmotion: blame-self | blame-tool | freeze | debug-eager
- socialProofNeed: low | medium | high
- aestheticSensitivity: low | medium | high    # maps to visual clutter sensitivity
- controlNeed: low | medium | high             # progressive disclosure vs all knobs
```

### 4. Cognitive thresholds

```markdown
## Cognitive thresholds
- featureSprawl: 2
- visualClutter: 2
- interactiveClutter: 3
- choiceOverload: 2
- informationDensity: 3
- noveltyTax: 2
- contextSwitchTax: 2
- workingMemoryLoad: 2
- interruptionFragility: 3
```

See `cognitive-thresholds.md` for channel definitions. Integers **0–5** = max acceptable **load**.

### 5. Existing HCD sections (still required)

Who I am · Goals · Constraints · Accessibility & inclusion needs · Success looks like · Failure modes I hate · Vocabulary I use · Review instructions  

Review instructions **must** mention:

- primary harm metrics  
- positive (delight) metrics  
- cognitive channels + thresholds  
- bus write-ahead  
- survey voice  

## Market segment registry (optional)

```text
.optimizexp/segments/<segment-id>.md
```

Optional short files for shared segment definitions (problem, willingness-to-pay band, success metrics). Personas reference `segmentIds`.

## Diversity / coverage rules

When resolving personas for a run (and for `--init`):

1. Prefer a **cover set** across `roleFamily` and at least two of `{seniority, orgArchetype, trustInAutomation}`.  
2. `--max-personas N` still applies; rank by `marketPriority` then `priority` then diversity bonus (unique roleFamily first).  
3. Product init should seed **multiple segments**, not one “developer” only.

## Scoring with models

| Persona field | Affects |
|---|---|
| low noveltySeeking | higher weight on noveltyTax breaches; lower excitement from gimmicks |
| high aestheticSensitivity | stricter visualClutter threshold already; harsher ease/optimality if visual contrast checks fail |
| low trustInAutomation | AX delight requires fail-closed honesty; dark patterns → harms↑ |
| junior + low timeBudget | informationDensity and featureSprawl heavily penalized |
| coding-agent segment | contextSwitchTax and skill sprawl dominate |

Judges **must** cite model fields in scorecard rationales when they drive a score ≥ 2 (harm or cognitive) or delight ≤ 3.

## Generation

`--persona` rewrite and `generate-persona.mts --mode scaffold` produce **schemaVersion: 2** with placeholder models the agent must fill from the seed **without stereotypes**.

Validate:

```bash
node --import tsx .agents/skills/optimizexp/harness/generate-persona.mts \
  --mode validate --id product-app-developer
```

## Anti-patterns

- Real PII or “KYC” of actual humans  
- Racist/sexist/ableist stereotypes as psychographics  
- One persona claimed to represent “everyone”  
- Thresholds all set to 5 (disables constraint system)  
- Demographics without psychographics (or reverse)

## Related

- [personas.md](personas.md) — file contract + prompts  
- [cognitive-thresholds.md](cognitive-thresholds.md)  
- [equilibrium.md](equilibrium.md)  
- [persona-survey.md](persona-survey.md)  
