# VS Code Extension Contract POC

Independent POC for HOBO-180. It pins the optional VS Code extension boundary
without building a production extension host, web dashboard, authoring tools, or
the underlying read projections.

## What It Proves

- Opening a HoBo project renders a `TopologyView` window from the existing
  inspect/read surface.
- Selecting a run renders a `RunView` step trace, timeline, actors, and sagas.
- "Explain this plan" annotates the `hobo plan --json` diff in editor-shaped
  messages and records no provisioning side effects.
- Provider-option completion for `.with(aws.)` is sourced from shipped provider
  types.
- The VS Code commands are explicitly bound to existing CLI verbs and MCP tools,
  so the extension does not grow divergent business logic.
- Missing local `hobo dev`/Camp reachability shows a start-dev prompt instead of
  error spew.
- Large topologies use a windowed graph model to keep editor rendering bounded.
- Credential use is a reference to the CLI SVID store; embedded static secrets
  fail the contract.
- CLI/extension surface version drift warns instead of rendering stale data.

## Scope Boundary

This package consumes the existing `hobo plan`, `hobo inspect`, RunView, and MCP
draft contracts. It does not implement the production VS Code extension runtime,
webviews, editor packaging, projection storage, CLI/MCP internals, auth issuer,
or non-VSCode editor integrations.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\vscode-extension-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Vscode Extension Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
