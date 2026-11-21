---
type: Agent Skill Reference
title: "Implementation loop"
description: "Iterate on HoBo repo changes with scoped edits, narrow feedback, and preserved user work."
tags: [hobo, repo, implementation, iteration]
timestamp: 2026-06-30T00:00:00Z
---

# Implementation Loop

Keep the loop narrow and evidence-driven.

## Loop

1. Search for existing patterns and commands.
2. Read the minimum files needed to understand the change.
3. Make scoped edits only in directly related files.
4. Update matching docs when changing code, automation, package metadata, CI, hooks, or agent tooling.
5. If the change is visual, use the owning surface’s implemented tokens and components, run `pnpm run design:lint`, and run the affected rendered-surface tests. See repo-root `AGENTS.md` “Visual quality”.
6. Run the smallest relevant check.
7. Broaden validation only when the change crosses package, contract, or tooling boundaries.

## Scope Control

- Prefer existing repo scripts and package patterns.
- Do not invent broad abstractions unless existing duplication or risk justifies them.
- Do not hand-edit generated files.
- Use TypeScript-family files for new JavaScript-family implementation.
- Work with user changes in touched files; never revert unrelated changes.
