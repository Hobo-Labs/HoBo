# HOBO-437 Troubleshooting Guides M0 Scope Proof

HOBO-437 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/troubleshooting-guides-scope-acceptance`](../../../../src/draft/exp-proofs/dx/troubleshooting-guides-scope-acceptance/README.md)
and the durable scope record at [troubleshooting-guides.md](../../troubleshooting-guides.md).

## Acceptance Evidence

- User and business goal is explicit for safe troubleshooting guidance and owner routing.
- Primary personas cover first-time app developer, coding agent, support operator, platform
  engineer, and docs maintainer.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to DX, role walkthroughs, launch support, support SLA channels, incident
  communications, public status-page boundaries, and ADR-0064.
- Owning initiative dependencies map Troubleshooting Guides, Docs Portal, Support Workflow, launch
  support, incident communications, public status page, and release cutline without taking their
  scope.
- M1 evidence is listed as guide taxonomy, symptom-to-owner map, safe-action fixtures,
  agent-readable runbook snippets, security redaction rules, and support escalation handoff.
- Follow-up M1-M4 work is blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects support-queue, production-remediation, provider-credential, marketing,
  UI, runtime, and live-customer-data creep inside M0.
- Evidence validation rejects troubleshooting claims without a proof mode.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.
- Handoff classification routes support, incident, and status-page work out of guide scope.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\troubleshooting-guides-scope-acceptance test
```
