# Connector Authoring Contract POC

This POC pins the M0 `connector()` authoring contract for HOBO-43.

It defines:

- `connector(name)` as an external dependency declared from a target Capability Manifest `auth.json`.
- A generated typed-client shape derived from advertised operations.
- Usage-inferred `allow` scope lowering into a `hobo.manifest/v1` external-dependency entry.
- Narrow-only `.allow(...)` with an explicit compare marker for `can-deploy`.
- Fallback recording when a target advertises `oauth2-obo` / MCP OAuth instead of `oauth2-xaa`.
- Fail-closed validation for unadvertised or malformed scope strings.

Runtime token brokering, ID-JAG exchange, usage static analysis, policy deny-ceiling evaluation, and `connector(name).connection().token()` execution are intentionally out of scope. Those remain owned by the identity, inference, policy, and runtime slices.

## Verification

Run the focused contract suite:

```powershell
npm.cmd --prefix src\draft\technical-proofs\connector-authoring-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Connector Authoring Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
