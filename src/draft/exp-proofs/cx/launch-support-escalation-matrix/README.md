# Launch Support Escalation Matrix POC

Independent POC for HOBO-408. It pins the M0 launch support escalation matrix without implementing
support tooling, ticket automation, admin console views, status-page publishing, runbook dispatch, or
customer-facing response SLAs.

## Contract Surface

- `launchSupportEscalationMatrix` is the deterministic M0 record.
- Severity levels cover first responder, escalation owner, expected response, customer
  communication, and handoff criteria.
- Support/debug prerequisites cover observability access, incident timeline, tenant context,
  status-page redaction, runbook notification, and release/feature context.
- Communication templates carry audience, channel, body placeholders, evidence source, and redaction
  gate.
- Gap routes map missing readiness work to support, admin console, operators/SRE, and
  reliability/observability/cost lanes.

## Scope Boundaries

Included:

- Deterministic M0 fixture and validator.
- Draft customer communication templates.
- Follow-up gate for downstream support execution issues.
- Scope guards for unapproved SLA promises and support-tooling implementation creep.

Excluded:

- Live ticketing, status-page, notification, runbook, admin console, or observability integration.
- Public support tiers, response-time guarantees, or final customer SLA language.
- Incident detection, alert routing, or production on-call implementation.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\launch-support-escalation-matrix test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Launch Support Escalation Matrix.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
