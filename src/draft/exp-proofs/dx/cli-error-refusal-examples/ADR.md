# ADR: CLI Error Refusal Examples

## Status

Accepted for HOBO-558.

## Context

The resource lifecycle vibe slice needs stable refusal examples before downstream docs, CLI
transcripts, MCP tool examples, SDK envelopes, dashboard copy, or support workflows can reuse the
wording. The examples must stay honest about proof mode and fail closed whenever evidence is
missing, stale, simulated, or reference-only.

## Decision

Record HOBO-558 as a package-local reference catalog under
`src/draft/exp-proofs/dx/cli-error-refusal-examples`. The package uses parse, don't validate: raw
catalog fixtures are parsed once into derived parsed types by `parseCliErrorRefusalCatalog`, and
malformed records are rejected before any downstream consumer can treat them as accepted examples.

The command is "record or consume a CLI error/refusal example". The actor is the
CLI/API/MCP documentation proof aggregate. Accepted records can emit `cliErrorRefusalExample.*`
events to an event-store in later implementation. Materialized views and projections expose the
current catalog to docs, SDK, CLI, and MCP consumers. Snapshots of the accepted catalog are persisted
in a read store so downstream examples can be replayed without live auth, provider, support, or
dashboard dependencies.

## Consequences

- The proof package carries protobuf, CUE, and Pact boundary evidence.
- Terminal copy, JSON output, MCP tool result shape, exit code, proof mode, fixture id,
  accessibility notes, and customer-safe wording are checked together.
- Refusal examples consume accepted HOBO-572 `dx.lifecycle.*` fixture facts and
  repeat the fixture proof mode so downstream consumers do not invent one-off
  evidence.
- Live auth/provider checks, production error handlers, support ticket automation, and dashboard
  copy remain out of scope until the CLI/API/SDK envelopes are accepted.
