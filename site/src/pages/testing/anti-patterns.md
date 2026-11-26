---
layout: ../../layouts/Docs.astro
title: What not to do
description: "Testing anti-patterns: drifting mocks, multi-writer SQLite myths, retrying policy denials, live E2E as discovery, and COUNT(*) revisions."
---

# What not to do

| Anti-pattern | Do instead |
|---|---|
| Hand-written long-lived mocks | Contract examples / effect harness mocks |
| `COUNT(*)` as stream revision | Stream head revision |
| Multi-writer shared SQLite over NFS as “HA” | Single-owner partitions; add partitions to scale |
| Retry `policy.Decided` denials “to be resilient” | Fix policy or satisfy obligations |
| Retry `STALE_FENCE` as OCC | Re-acquire lease; new fence |
| Live cloud E2E in every PR | Contract + local Camp + rehearsal |
| Broad full-repo test sweeps for discovery | Search first; narrow package tests |
| Wall-clock sleeps in pure domain tests | Virtual Clock |
| Assert process memory for audit | Replay events |
| Put LLM tokens in EventStore | Streamer |
| Bare `.hobo` hosts in fixtures | `.hobo.localhost` / `.hobo.test` |
| Invent parallel progressive plane beside Harness | Use Harness + Trails |
| Pool free-tier headroom across tenants in tests that claim “prod realism” | Model per-tenant isolation |

## Related

[Testing overview](/HoBo/testing/) · [Errors](/HoBo/reference/errors/) · [Security](/HoBo/security/)
