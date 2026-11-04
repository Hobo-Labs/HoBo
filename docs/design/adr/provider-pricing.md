---
type: Architecture Decision Record
title: "Provider Pricing and Commercial Terms"
description: "Deterministic provider-cost quotes use fail-closed decimal rating beside the unchanged dispatcher v1."
tags: [hobo, design, adr, pricing, finops, dispatcher]
---

# ADR-0176 — Provider Pricing and Commercial Terms {#adr-0176}

**Status:** Accepted
**Date:** 2026-11-03

## Context

Provider routing needs auditable commercial-cost comparisons without turning
provider charges into customer billing. Partial observations, ambiguous rate
cards, implicit unit conversions, floating-point arithmetic, and live price
lookups would make replay unsafe or make missing data look free.

## Decision

Adopt the [Provider Pricing and Commercial Terms design](../provider-pricing-commercial-terms.md)
and its `@hobo/pricing` package. Money and quantities use exact decimal strings;
all scaled-integer arithmetic is isolated in `decimal.ts`. The pure quote engine
returns a structured rejection for stale, partial, ambiguous, unsupported, or
cross-currency inputs. External provider quotes are persisted evidence, never an
excuse for a live call during rating or replay.

Batch 1 establishes the protobuf/CUE contracts, catalog/state rating kernel,
golden replay corpus, and quote-boundary PACT. Dispatcher v1 remains untouched;
a later dispatcher v2 adapter may consume `QuoteVector` without
`allocatedEffective`.

## Consequences

- Quotes are deterministic and replayable from pinned catalog and state hashes.
- Unsupported commercial terms reduce eligibility rather than silently rating as zero.
- New provider agreements and cancellations remain default-deny.
- Legacy CI translation, broker/cloud hooks, and dispatcher v2 are separate batches.
