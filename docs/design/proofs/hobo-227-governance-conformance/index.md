# HOBO-227 Governance Conformance Proof

This proof backs [PLAN-29](../../contracts-policy-flags.md#plan-29),
[PLAN-46](../../governance-planes.md#plan-46),
[ADR-0015](../../adr/02-identity-security.md#adr-0015),
[ADR-0044](../../adr/02-identity-security.md#adr-0044),
[ADR-0046](../../adr/02-identity-security.md#adr-0046),
[ADR-0060](../../adr/02-identity-security.md#adr-0060),
[ADR-0061](../../adr/02-identity-security.md#adr-0061), and
[ADR-0074](../../adr/02-identity-security.md#adr-0074).

The branch adds
[`src/draft/technical-proofs/governance-conformance-suite-contract`](../../../../src/draft/technical-proofs/governance-conformance-suite-contract/README.md),
an independent POC for the GA `hobo verify` composition boundary. It consumes gate results from the
contract, policy, obligation, residency, guardrail, quota, and signing slices, then produces one
replayable deployability decision plus a governance ADR/Plan traceability check.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| E2E suite passes an all-green deploy. | `passes the composite hobo verify decision only when every governance dimension passes` |
| Each single failing dimension blocks with the right reason. | `blocks with a precise reason for each single failing governance dimension` |
| Composite decision replays identically from the event log. | `replays the composite decision deterministically from the emitted decision log` |
| ADR and Plan map shows every governance decision covered or flagged. | `validates that every governance Plan and ADR is covered or explicitly scoped out` |
| Policy decision-log golden replay matches. | `matches a golden replay corpus for policy decision logs` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Partial gate success must not pass composite. | `does not pass partial gate success as a composite decision` |
| ADR decision with no mapped slice is flagged. | `flags an ADR decision with no mapped slice` |
| Replay is deterministic. | `replays the composite decision deterministically from the emitted decision log` |
| Absent cross-team gate result blocks, not skipped. | `blocks absent cross-team gate results instead of skipping them` |

## Scope Boundary

- Individual contract, policy, obligation, residency, guardrail, quota, and signing engines are
  consumed as fixture-shaped inputs.
- Progressive-delivery rollout mechanics, identity engines, data-governance engines, FinOps
  counters, and AI-safety engines remain owned by their respective slices.
- This package is not a doc-lint replacement; it is the HOBO-227 governance traceability fixture.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\governance-conformance-suite-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
```
