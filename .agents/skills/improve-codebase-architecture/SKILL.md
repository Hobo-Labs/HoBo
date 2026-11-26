---
name: improve-codebase-architecture
description: Inspect and improve an existing codebase's architecture through implemented, verified changes.
disable-model-invocation: true
---

# Improve codebase architecture

Follow `AGENTS.md`. Inspect the requested behavior, its callers, and existing tests. Identify concrete friction, then implement the requested refactor with precise names, types, and small interfaces. Preserve observable behavior unless the user requests a change, and update affected contracts and callers.

Run focused tests and the required checks. Explain material tradeoffs in the response or pull request. Do not create architecture reports, ADRs, plans, diagrams, or placeholder implementations, and do not stop at recommendations when implementation is requested.
