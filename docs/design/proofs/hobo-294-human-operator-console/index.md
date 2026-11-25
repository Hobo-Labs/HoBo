# HOBO-294 Human Operator Console Proof

This proof pins the incidents and approval surfaces from
[Plan 07](../../developer-experience.md#plan-07), the Crew/SRE A2H and gated
remediation path from [Plan 40](../../operators-sre.md#plan-40), operator agent
MCP parity from [ADR-0054](../../adr/03-data-plane.md#adr-0054), and gated SRE
incident management from [ADR-0058](../../adr/03-data-plane.md#adr-0058).

Executable proof:

- package: `src/draft/technical-proofs/human-operator-console-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\human-operator-console-contract test`

Acceptance coverage:

- open incident projection includes MTTD, MTTR, and replayed SRE decision trail.
- pending `remediation.require-approval` actions surface in both console
  projection data and MCP list tools.
- approving a gate emits `policy.Decided(effect=allow)` before
  `crew.ActionApplied`.
- replay removes the pending approval and preserves the decision trail from the
  event log.
- deny and abort use the same command surface and resolve through
  `crew.ActionDenied`.

Adversarial coverage:

- viewer principals can read but cannot approve gated actions.
- each approval must carry the action plus blast-radius snapshot hash currently
  pending; stale approvals fail if the action or blast radius changes.

Scope boundary:

- dashboard rendering, status pages, fleet/availability views, and frontend
  polish are out of scope.
- SRE diagnosis, remediation proposal generation, on-call paging, and provider
  runtimes are consumed from adjacent contracts rather than rebuilt here.
