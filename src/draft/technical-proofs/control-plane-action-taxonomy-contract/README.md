# Control-Plane Action Taxonomy Contract

Independent HOBO-154 proof for the `hobo:<resource>:<verb>` control-plane action surface.

This draft package pins the Plan 29 taxonomy as executable data and provides the smallest
contract helpers needed by later policy/RBAC work:

- stable action IDs for every listed resource/verb row;
- a completeness gate for CLI/MCP verbs that must map to an action ID;
- DecisionRequest lowering to `{ resource: hobo:<resource>, action: <verb> }`;
- explicit exclusion of secret-broker value reads;
- high-privilege derivative, registry bundle-import, and relay actions; and
- `manage` expansion limited to verbs declared on that resource.

Scope intentionally stops before role bindings and the policy engine. Those are separate slices.

## Verify

```sh
npm.cmd --prefix src/draft/technical-proofs/control-plane-action-taxonomy-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Control Plane Action Taxonomy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
