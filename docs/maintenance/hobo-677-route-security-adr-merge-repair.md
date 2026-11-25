---
type: Reference
title: "Maintenance note - HOBO-677"
description: "Maintenance note for the HOBO-677 route-security ADR merge-conflict repair."
tags: [hobo, maintenance]
---

# Maintenance note - HOBO-677

Date: 2026-07-02

Automation run `cursor/linear-issue-blockers-23d8` rebased
`cursor/hobo-677-hobo-agent-workflow-c7ed` onto `origin/main` and resolved ADR
numbering conflicts by keeping main's ADR-0107 (hosted-business commercialization)
and renumbering the route-level API security decision to **ADR-0114** in
`docs/design/adr/02-identity-security.md`.

Gates: `pnpm agent:check -- --base=origin/main` (docs/traceability lanes).
