# ADR: Control-Plane Resource Lifecycle API Shape Proof

## Status

Accepted for HOBO-569 proof.

## Context

The DX backbone needs API examples for plan, apply/up, inspect, logs,
import/adopt, migrate, rollback, and support evidence. Those examples must be
usable by CLI, SDK, dashboard, and MCP surfaces without giving any proof package
authority to implement the production REST server or live providers.

## Decision

Represent the proof as an exp-proof package with one parsed contract object:

- operation records name CLI command, API endpoint, MCP tool, request shape,
  response shape, domain terms, and fixture id;
- refusal envelopes are shared across surfaces and include remediation, proof
  mode, fixture id, and redaction class;
- protobuf, CUE, and Pact artifacts live inside the package and use the same
  lower-camel parsed fixture body where JSON is exchanged; and
- `parseControlPlaneApiResourceLifecycleProof` is the only boundary that turns
  raw fixture data into a parsed derived type.

## Alternatives

- Build a real REST or MCP server. Rejected: HOBO-569 is a shape proof and
  explicitly scopes out production endpoints.
- Put examples only in markdown. Rejected: acceptance requires executable
  proof and API/MCP parity.
- Reuse HOBO-567's unmerged files directly. Rejected: this branch can read the
  scenario matrix for vocabulary, but must be mergeable on `origin/main`
  without depending on another open PR.

## Consequences

Downstream transcript, fixture corpus, and quickstart slices can consume the
same operation ids and refusal codes. Production behavior still belongs to the
later CLI/MCP/control-plane implementation issues.
