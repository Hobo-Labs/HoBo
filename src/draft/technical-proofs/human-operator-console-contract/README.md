# Human Operator Console Contract

Independent POC for HOBO-294. It proves the operator surface stays projection
and event backed:

1. open incident projections expose MTTD/MTTR and a replayed SRE decision trail;
2. `remediation.require-approval` obligations surface in both the console
   projection and MCP tools;
3. approve, deny, and abort share the same dashboard/MCP command path;
4. approvals are RBAC-gated and bound to the exact action plus blast-radius
   snapshot the operator reviewed.

## Executable Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\human-operator-console-contract test
```

The tests cover the acceptance and adversarial cases from HOBO-294:

- a pending require-approval action is visible through projection and MCP list
  tools;
- approval emits `policy.Decided(effect=allow)` before `crew.ActionApplied`,
  then replay removes the pending gate and shows the trail;
- deny and abort resolve the same gate through `crew.ActionDenied`;
- viewers cannot approve;
- stale approvals fail when the action or blast-radius snapshot changes.

## Scope Boundary

This package does not implement a rendered dashboard, status pages, fleet views,
frontend styling, or provider/SRE runtimes. It consumes projection/event facts
from the adjacent incident, crew, remediation, and escalation contracts.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Human Operator Console Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
