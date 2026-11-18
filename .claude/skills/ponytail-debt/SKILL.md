---
name: ponytail-debt
description: Find and resolve shortcut markers in the codebase, or report them inline when the user asks only for an audit.
---

Follow `AGENTS.md`. Search for existing `ponytail:` markers with `rg`, excluding
generated output and dependencies. Inspect the implementation and its callers.
When implementation is requested, complete the behavior, remove the marker, and
run focused checks. If the behavior already exists, remove the stale marker.

When the user requests only an audit, report findings inline with file locations.
Do not add shortcut comments, create debt ledgers, or defer requested work.
