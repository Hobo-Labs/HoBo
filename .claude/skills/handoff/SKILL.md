---
name: handoff
description: Summarize the current work for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Follow `AGENTS.md`. Summarize the current work inline so a fresh agent can continue it. Do not create a handoff, planning, or design file.

Suggest relevant skills when they would help the next agent.

Reference existing implementation, commits, and pull requests instead of duplicating them.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, use them to tailor the summary to the next session.
