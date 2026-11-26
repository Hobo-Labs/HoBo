---
layout: ../../layouts/Docs.astro
title: Bridge modes
description: "live, mock, bridge, replay, shadow, and fault — the same boundary modes for tests and local/remote development."
---

# Bridge modes

Boundary modes are not only a test helper. They are the same routing model used by **[the Bridge](/HoBo/troubleshooting/bridge/)** for local/remote development.

## Mode table

| Mode | Behavior |
|---|---|
| **live** | Call the real implementation / deployed boundary |
| **mock** | Serve contract-conformant fakes (examples / effect mocks) |
| **bridge** | Fork only the tagged **session’s** traffic to a local implementation; must pass contract check before activation |
| **replay** | Serve recorded outputs; no original dependency required |
| **shadow** | Candidate receives traffic; output compared and **never** returned to callers |
| **fault** | Inject failures for a **session only** |

## Session scoping

Fault and bridge modes are **session-tagged**. Break a dependency for `tyler/chaos` without taking down production traffic for everyone else.

```ts
payments.fault({ message: "simulated outage", session: "tyler/chaos" });

await payments.call(charge, { session: "tyler/chaos" }); // fails for you
await payments.call(charge); // fine for others
```

## Contract gate on bridge activation

A bridge that would carry traffic **must** satisfy the BoundaryContract first. Failures surface as typed contract errors — not silent skew.

## Recording

Recording stays on: interactions become specification-by-example traces and training material (with lane-origin events excluded from baseline promotion by default).

## Next

- [The Bridge](/HoBo/troubleshooting/bridge/)
- [Chaos & availability](/HoBo/testing/chaos/)
