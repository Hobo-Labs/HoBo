# Capability-Indexed Discovery Contract POC

This POC pins the M1 discovery input for HOBO-362: a certified-listing index keyed by WIT
`interface@semver@stability`, Matching criteria, and region/classification filters. The same pure query
surface is exposed through an SDK-style API and an MCP tool wrapper so agents can discover candidates
during planning before a later `hobo add` install flow.

It defines:

- `createCapabilityDiscoveryIndex()` for applying `listing.Certified` and `listing.Yanked` lifecycle events.
- `find({ port, criteria })` for deterministic, ranked discovery over currently certified listings.
- Strict region/classification filters over listing Matching metadata.
- `createDiscoveryMcpTool(index)` as the agent-facing MCP surface that delegates to the same lookup path.
- A typed fixture descriptor that embeds the existing `hobo.capability-spec/v1` declaration.

Scope intentionally stops before install/verification, version resolution, trust-tier composite ranking, and
Matching's own provider selection. Ranking here is only deterministic discovery ordering.

## Verification

Run the focused contract suite:

```powershell
npm.cmd --prefix src\draft\technical-proofs\capability-indexed-discovery-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite and typed consumer fixture.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Capability Indexed Discovery Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
