---
layout: ../../layouts/Docs.astro
title: Streamer port
description: "Streamer: high-volume frames outside the domain event log; StreamRun lifecycle, fromSeq replay-then-live, and Camp coupling rules."
---

# Streamer port

The **Streamer** carries **per-frame** high-volume payloads — LLM tokens, progressive UI chunks, log lines, exec stdout — without turning the domain EventStore into a blob store.

## Separation of concerns

| Layer | Holds |
|---|---|
| **EventStore** | Domain and control **facts** (past-tense, foldable, audit) |
| **Streamer journal** | Frame **bodies** for a run (dev-grade in-memory until teardown unless upgraded) |
| **Optional audit opt-in** | Policy may require selected frames as events — not the default |

Yard is **never** on the streaming data path. Live tails (`hobo logs`) go Camp → Streamer.

## Lifecycle

Run lifecycle may be event-sourced even when bodies are not:

- `StreamRunOpened` / related open facts
- Frames append with monotonic sequence within the run
- `StreamRunClosed` (or failure terminal)

Readers attach with `fromSeq` for **replay-then-live**: catch up stored frames, then subscribe for new ones — same mental model as EventStore subscriptions.

## Guarantees

| Claim | Status |
|---|---|
| Ordered frames per run | Yes (seq) |
| Durable domain audit of every token | **No** by default |
| Exactly-once delivery to all subscribers | **No** — at-least-once / best-effort per engine |
| Cross-Camp frame federation | Out of scope for the port |

## Coupling rules

- Aggregates and workflows **must not** dump large progressive payloads into EventStore “for convenience.”
- Executors stream `exec.Output` through Streamer; Dashboard projections show live progress from those frames + control events.
- Deterministic replay of **domain** state never depends on Streamer contents.

## Testing

- Unit: mock Streamer; assert open/close and `fromSeq` contract.
- Behavior: `hobo logs` / Bridge live-tail modes against contract fixtures.
- Do not require live cloud sinks for PR gates.

## Related

[Runtime ports](/HoBo/reference/runtime-ports/) · [Data plane](/HoBo/architecture/data-plane/) · [CLI](/HoBo/reference/cli/)
