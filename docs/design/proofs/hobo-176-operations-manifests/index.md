# HOBO-176 Operations Manifests Proof

This proof records the branch-local contract package for HOBO-176.

## Issue Boundary

- Scope in: operations-facing `llms.txt`, `llms-full.txt`, and `docs.json`
  generated from the canonical HOBO-8 CLI verb surface and HOBO-168 MCP tool
  surface; well-known serving paths; `docs.json` schema validation; CLI/MCP
  drift checks; MCP input/output schema publication; MCP-first operation routes;
  internal-tool filtering; bearer/secret-shaped redaction; deterministic default
  descriptions with metadata warnings; and routeable agent intents.
- Scope out: the production Yard web server, the production MCP server,
  per-app authoring manifests, and the human docs site.

## Executable Proof

- Package: `src/draft/technical-proofs/operations-manifests-contract`
- Generate snapshots: `npm.cmd --prefix src\draft\technical-proofs\operations-manifests-contract run generate`
- Focused gate: `npm.cmd --prefix src\draft\technical-proofs\operations-manifests-contract test`

The tests exercise the acceptance bullets and adversarial cases in HOBO-176:
fresh generated snapshots, schema validity, route lookup without human docs,
drift failure when verbs/tools change, MCP schema publication, CLI/MCP parity
reuse, no internal-only tool leakage, redaction, incomplete-metadata warnings,
and deterministic output.
