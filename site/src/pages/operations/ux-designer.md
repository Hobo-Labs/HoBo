---
layout: ../../layouts/Docs.astro
title: UX Designer
description: "Crew operator that generates and maintains app UI against implemented UI tokens under guardrails and contract boundaries."
---

# UX Designer (Crew)

Generates and maintains application UI against implemented visual tokens — for this site the palette is `site/src/styles/global.css` (rubberhose / Steamboat Willie / Cuphead) — under the same guardrails and sandbox rules as other generators. The independent `scripts/visual-token-contract.json` is the reviewed palette authority. Root `pnpm run design:lint` executes the contrast gate, fails closed for missing or unreadable palettes, and works with the affected package's design-lint and rendered-surface tests to reject unauthorized changes.

## Mission

- Propose UI diffs in sandbox lanes 
- Keep components aligned with design tokens/specs 
- Never ship unguarded prompt output to prod without policy 

## Boundaries

- Uses MCP/tools with scoped credentials 
- Pairs with SWE for behavioral code 
- Accessibility baselines are gates, not suggestions 

## Related

[Generation](/HoBo/cicd/generation/) · [SWE](/HoBo/operations/swe/) · [Shared model](/HoBo/operations/shared-model/)
