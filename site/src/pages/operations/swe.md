---
layout: ../../layouts/Docs.astro
title: SWE operator
description: "Crew SWE: implement, refactor, and repair business and message code behind ports; generate idiom-layer SDKs under gates."
---

# SWE operator

**Mission:** implement / refactor / repair **business and message** code behind ports; generate per-language idiom-layer SDKs from `hobo:sdk` under conformance.

## What it does

- Opens gated Deltas/PRs for region-scoped AST edits with provenance.
- Runs implement / refactor / repair loops against contracts and tests.
- Generates language idiom layers — **only** promoted when conformance + eval + policy pass.
- Files issues on the issue-tracker port when human follow-up is required.

## MCP surface (illustrative)

`implement` · `refactor` · `repair` — each produces reviewable diffs, not silent production patches.

## Gates

| Gate | Role |
|---|---|
| Conformance | Port honesty |
| Evals / rubrics | Quality thresholds for generated code |
| Policy | Prod often require-approval |
| Golden | Regression lock |

## What it is not

- Not the Platform Engineer (platform definitions vs app business code).
- Not unbounded “agent with cloud keys” — short-lived credentials + audit.

## Related

[Generated stack concepts in Architecture](/HoBo/architecture/) · [Shared model](/HoBo/operations/shared-model/) · [UX Designer](/HoBo/operations/ux-designer/)
