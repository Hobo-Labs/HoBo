---
layout: ../../layouts/Docs.astro
title: Local debugging
description: "Debug HoBo offline: hobo dev, local Camp, SQLite journal, dual fixtures, and doctor."
---

# Local debugging

## First loop

1. `hobo doctor` — environment, credential, and portability hazards 
2. `hobo dev` — offline local Camp / in-process handlers 
3. `hobo plan` / `hobo verify` — dry-run and Gatekeeper without cloud mutate 
4. Project tests — effect isolation, durability, contracts (see [Testing](/HoBo/testing/))

## Useful defaults

| Concern | Local default |
|---|---|
| EventStore | SQLite single-owner partition |
| Secrets | Schema-only view + fixtures — no plaintext in agent context |
| Session Replay | On for local dual fixtures (`HOBO_REPLAY=0` kills) |
| Named endpoints | `.hobo.localhost` |

## When local is green but remote fails

Compare Bridge modes and credentials — [Remote development](/HoBo/troubleshooting/bridge/) · [Remote debugging](/HoBo/troubleshooting/remote/).

## Related

[Common failures](/HoBo/troubleshooting/common-failures/) · [Durable EventStore tests](/HoBo/testing/durability/)
