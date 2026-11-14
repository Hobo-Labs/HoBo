---
type: Agent Skill Reference
title: "SDLC brainstorm & hardening"
description: "Idea generation with adversarial and rubber-duck hardening before any planning."
tags: [hobo, sdlc, brainstorming]
timestamp: 2026-07-02T00:00:00Z
---

# Brainstorm & harden

Every feature/capability starts here — never at implementation.

## Generate

Use the Superpowers `brainstorming` skill when the plugin is enabled; otherwise run the local
`grilling`/`prototype` skills. Produce 3+ distinct approaches before converging; name the user
problem, the affected personas (Dana/Atlas/Priya/Omar per the requirements), and the pillars the
idea serves.

## Harden (all three passes, in order)

1. **Adversarial:** red-team the surviving idea — failure modes, abuse cases, cost blowups,
   security/tenancy holes, "what breaks the five-pillar promises?". Record kills and survivals.
2. **YAGNI:** apply `ponytail` — what can be deleted from the idea before it exists? Prefer
   extending an existing proof/port over inventing a new one (search src/draft/ and docs/design/
   first; the design suite probably already decided something adjacent).
3. **Rubber-duck:** explain the idea back step by step as if to a new contributor; every step you
   cannot justify plainly goes back to (1).

## Exit criteria (all must hold before planning)

- Problem statement + measurable success criteria written down.
- Survived all three passes with the kill-log kept.
- Named the draft-cascade footprint: which technical proofs, which experience types, which epic.
- User agrees it is worth planning.

Write the outcome into `.sdlc/<initiative-slug>/sdlc-state.md` (phase: brainstormed,
decisions, kill-log) before moving on.
