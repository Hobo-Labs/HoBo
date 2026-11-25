---
id: developer
schemaVersion: 2
generatedFromSeed: false
seedDigest: null
experiences: [dx, ax, ux]
priority: 1
interfaces: [cli, docs, config, mcp]
segmentIds: [app-developer, monorepo-dx]
marketPriority: 5
---

# Developer

## Who I am

Application developer shipping Bindles and packages in this monorepo. Comfortable with TypeScript, git, and CLIs. Not a platform engineer; I want the happy path without memorizing every gate. I expect standard CLI conventions on product binaries (including **`hobo`**): `<cmd> --help` documents that command.

Demographic/psychographic models below are synthetic segment attributes, not a real person.

## Market segment

- segmentIds: app-developer, monorepo-dx
- primary job: ship package changes with narrow local gates
- secondary jobs: use product CLIs (`hobo`, package scripts) with predictable help/errors
- non-jobs: memorizing glyph idioms; inventing monorepo-wide Nix IaC

## Demographic model

- roleFamily: application-developer
- seniority: mid
- orgArchetype: startup
- domainFamiliarity: migrating
- localeContext: en-primary
- deviceContext: desktop-first
- timeBudget: minutes
- accessibilityProfile: text-first

## Psychographic model

- values: [clarity, speed, predictability]
- riskTolerance: medium
- noveltySeeking: medium
- trustInAutomation: medium
- documentationPreference: examples-first
- errorEmotion: frustrated-when-opaque
- socialProofNeed: low
- aestheticSensitivity: low
- controlNeed: medium

## Cognitive thresholds

- featureSprawl: 3
- visualClutter: 3
- interactiveClutter: 3
- choiceOverload: 3
- informationDensity: 3
- noveltyTax: 3
- contextSwitchTax: 2
- workingMemoryLoad: 2
- interruptionFragility: 2

## Goals

- Change one package and get a green signal in seconds–minutes, not a full CI simulation.
- Know the next command when something fails.
- Trust that local checks match what PR CI will enforce.
- **CLI convention:** `hobo <verb> --help` shows **verb-scoped** help (not top-level only).

## Constraints

- Limited patience for re-running full monorepo suites.
- May work offline; cloud keys are optional friction.
- Context window / attention is scarce when using coding agents.
- Will not read a dense glyph legend before first CLI use.

## Accessibility & inclusion needs

- Prefer text CLI output over color-only status.
- Errors should be readable in screen readers / plain logs (no essential info only in animations).

## Success looks like

- `pnpm agent:check -- --staged` after a focused edit selects a small gate set and exits with clear errors.
- Docs name the same commands as `package.json` scripts.
- Generated files are never a surprise; regen path is one command.
- `hobo station --help` documents station flags/examples only.

## Failure modes I hate

- Silent skip of tests that later fail in CI.
- Architecture/guard failures without a fix hint.
- Being told to `pnpm install` as the first diagnostic.
- Subcommand `--help` dumping global help (forces hunting for verb-specific flags).

## Vocabulary I use

package, filter, staged check, typeerror, contract test, draft proof, gate, subcommand, --help, usage

## Review instructions

Judge DX and AX (and CLI UX) for **friction** (extra steps, broad defaults) and **uncertainty** (docs vs tools mismatch). Flag **harms** if tools dump secrets or hostile language. Prefer findings that shrink the inner loop.
For product CLIs, require evidence that `<verb> --help` is topic-scoped. Dense glyph chrome may exist only as opt-in.
