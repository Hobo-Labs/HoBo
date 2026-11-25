# ADR: Shared DX Result And Refusal Envelopes

## Status

Accepted for HOBO-571.

## Context

The DX-first vibe backlog needs downstream examples to reuse one result shape
instead of inventing separate success, warning, refusal, support, and
proof-mode wording in SDK snippets, CLI transcripts, MCP tool results, docs,
or visual mockups. The referenced design records require honest uncertainty:
Gatekeeper denial, contract incompatibility, stale projections, non-reactive
sinks, and migration blockers must not look like generic failures or hidden
successes.

## Decision

Define one typed envelope catalog for the M1 shape proof. Each envelope must
carry human-readable copy, machine-readable code, remediation, proof mode,
fixture id, trace id, correlation id, redaction class, accessibility notes, and
copy notes. SDK, CLI JSON, and MCP examples are generated from the same parsed
record, so parity is a property of the fixture rather than a later editorial
check.

## Alternatives Considered

- Separate SDK, CLI, and MCP examples. Rejected because drift between examples
  would hide incompatibility and support routing bugs.
- Prose-only style guide. Rejected because downstream slices need executable
  fixture evidence and machine codes.
- Optimistic success defaults with optional warnings. Rejected because the
  design suite favors explicit refusal and uncertainty over proofless success
  claims.

## Consequences

Downstream deploy/manage/migrate transcript slices can consume these fixtures
without redefining refusal semantics. The package stays an experience proof:
production CLI/API/SDK implementation, provider calls, telemetry, and support
routing remain out of scope.

## Parse, Don't Validate

This package applies **parse, don't validate** at the boundary. Raw catalog
input is parsed once into parsed domain types such as `DxResultRefusalProof`
and `DxResultEnvelope`. Downstream SDK, CLI, and MCP example builders receive
those derived types instead of re-checking loose DTOs.

## Event Architecture Note

The conceptual actor is the DX envelope registrar. It accepts
`RegisterDxEnvelopeCatalog` and `ClassifyDxClaim` commands, emits
`dxEnvelope.CatalogAccepted` or `dxEnvelope.ClaimRejected` events to an
event-store stream, and materializes a projection for SDK, CLI, and MCP
consumers. The projection snapshot is the stable fixture set, and consumers read
from that read store rather than the raw event store. The proof keeps this event
architecture as fixture evidence only; it does not add production event
families.
