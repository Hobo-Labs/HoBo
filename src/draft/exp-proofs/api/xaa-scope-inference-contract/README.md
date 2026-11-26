# XAA Scope Inference Contract POC

This POC proves the HOBO-83 inference layer over the existing
`connector-authoring-contract` declaration surface.

It covers:

- static discovery of called `connector("target")` client operations from source text;
- operation-to-scope mapping against the target Capability Manifest `auth.json`;
- manifest `connectors.<target>.allow` lowering to the least-privilege observed scope set;
- `.allow(...)` narrow-below-usage contract failure markers for `can-deploy`;
- deny-by-default behavior for unused advertised scopes;
- fail-closed diagnostics for unadvertised operations, unadvertised mapped scopes, and dynamic
  operation names static analysis cannot prove;
- fixed `onBehalfOf: "user"` manifest entries for XAA grants.

Runtime ID-JAG brokering, policy deny-ceiling enforcement, `connector(name).connection().token()`, and typed
client generation remain out of scope for this slice.

## Verification

Run the focused contract suite:

```powershell
npm.cmd --prefix src\draft\exp-proofs\xaa-scope-inference-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Xaa Scope Inference Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
