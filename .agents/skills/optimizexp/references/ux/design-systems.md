---
type: Agent Skill Reference
title: "OptimizeXP UX — design systems"
description: "Audit patterns for design systems, tokens, components, and inclusive visual language."
tags: [hobo, optimizexp, ux, design-systems]
timestamp: 2026-07-30T00:00:00Z
---

# UX — design systems

## What to inventory

| Asset | Questions |
|---|---|
| Token source of truth | Single file? Generated? Drift between CSS and docs? |
| Component library | Documented states (hover/focus/disabled/error)? |
| Iconography & imagery | Inclusive? Avoids offensive symbolism? |
| Motion | Respects `prefers-reduced-motion`? |
| Theming | Light/dark or high-contrast coherent? |
| Content patterns | Error, empty, loading, success copy templates? |

## HoBo anchors

- `site/src/styles/global.css` — implemented site tokens
- `scripts/visual-token-contract.json` — independent reviewed palette contract
- `design-md` skill — always-on visual review and executable checks
- Exp proofs under `src/draft/exp-proofs/ux/`

## Friction / uncertainty checks

- Can a designer or agent change a token without hunting three files?
- Do component names match docs vocabulary?
- Are WCAG contrast failures gated (`design:lint`) or advisory-only?
- Do mockups in draft proofs use **real visuals** (gate) or placeholder modules?

## Harms checks

- Imagery or mascots that encode stereotypes
- Color-only status (no text/icon dual encoding)
- Flashing motion or seizure risk
- Copy that blames or shames the user

## Probe commands

```bash
pnpm run design:lint
pnpm --filter @hobo/status-page test -- test/status-page-design-lint.test.ts
pnpm --filter @hobo/mcp test -- test/secret-capture-design-lint.test.ts
```

Review the changed surface with impeccable `critique`, then `audit`; polish any
P0/P1 findings. Run the affected package's other rendered-surface tests too.

## Bus expectation sketch

```gherkin
Feature: Design token lint
  Scenario: Agent updates a color token
    Given the implemented CSS defines the palette
    When I run design:lint after a token edit
    Then contrast and structural rules fail closed with file references
```
