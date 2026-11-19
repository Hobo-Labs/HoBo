---
type: Reference
title: "Relay deploy workflow gates"
description: "Executable checks on .github/workflows/relay-deploy.yml."
tags: [hobo, ci, relay, workflow]
---

# Relay deploy workflow gates

[`scripts/test/relay-deploy-workflow.test.ts`](../../scripts/test/relay-deploy-workflow.test.ts)
pins the relay deploy workflow: the *Verify the secret store connection* step
must invoke `hobo ci secret-store verify` in its own body and must appear
before *Deliver the relay through HoBo CD* by step line order, not by
whole-file substring search.