# HOBO-83 XAA Scope Inference Proof

HOBO-83 is proven by `src/draft/exp-proofs/api/xaa-scope-inference-contract`.

The proof consumes the M0 `connector()` authoring contract and adds the M2 inference behavior:

- called `asana.tasks.create(...)` usage lowers to `allow: ["tasks:write"]`;
- unused advertised scopes are not requested;
- `.allow("tasks:read")` plus write usage emits a `can-deploy` contract failure marker;
- unadvertised operations and operation-to-unadvertised-scope mappings fail closed;
- dynamically constructed operation names become machine-readable coverage failures;
- manifest entries remain user-delegated with `onBehalfOf: "user"`.

## Commands

```powershell
npm.cmd --prefix src\draft\exp-proofs\xaa-scope-inference-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
```

## Scope Boundary

This proof does not implement runtime token brokering, ID-JAG exchange, policy deny-ceiling
evaluation, `connector(name).connection().token()`, or typed-client generation. Those remain owned by the
identity, policy, runtime, and codegen slices named in the Linear backlog.
