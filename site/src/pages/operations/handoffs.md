---
layout: ../../layouts/Docs.astro
title: Handoffs & A2H
description: "Agent-to-human handoffs with obligations, deadlines, evidence packs, and resume-without-amnesia."
---

# Handoffs & A2H

**A2H** (agent-to-human) handoffs are first-class: when policy requires approval or confidence is low, the agent opens an obligation with a deadline and an evidence pack — not a chat message that disappears.

## Loop

1. Agent proposes action (`crew.ActionProposed` / handoff request).
2. Obligation recorded (who, what, deadline).
3. Human approves, rejects, or amends with reasons.
4. Agent resumes from **events**, not process memory.
5. Satisfaction/closure is itself a fact.

## Rules

- Deadlines create operational urgency without silent auto-approve (unless policy explicitly says so).
- Evidence packs must be redaction-safe for the audience.
- Handoffs are not a bypass of Gatekeeper for infra mutate.

## Related

[Shared model](/HoBo/operations/shared-model/) · [Runbooks](/HoBo/operations/runbooks/) · [Policy](/HoBo/reference/policy/)
