# Scope Review

This review was completed before broadening the implementation beyond the selected epic. The selected epic is the Linear project `036f25f3-94bf-4253-ac06-d128eaedbf49`, Operators & SRE - the Crew.

## Accepted scope

- Built-in SRE and Endpoint Monitor behavior that proves the Crew model under Plan 40.
- Incident lifecycle, runbook selection, read-only diagnosis, failure taxonomy, policy-gated remediation, human approval, on-call handoff, integration ports, chaos boundary, runaway guard, MTTD/MTTR evidence, and DR failover integrity.
- Consumer-driven contract fixtures for every internal or external boundary touched by the reference implementation.
- Simulation-only mocks for missing providers. No live services, production tokens, or customer data.

## Rejected or deferred scope

- Real SLO computation and alert routing providers stay in the Reliability epic.
- Real policy engine implementation stays in Contracts/Policy.
- Real delivery orchestrator, flag-flip mechanics, and live rollout internals stay in Progressive Delivery.
- CLI/MCP journey proof from HOBO-216 is persona evidence only; this run does not implement CLI commands.
- HolmesGPT, StackStorm, PagerDuty, OpsGenie, Slack, Linear, GitHub Issues, and Confluence adapters are provider follow-ups.

## Adversarial findings

| Risk question | Decision |
|---|---|
| Could a POC be copied into production-shaped code? | No. The reference implementation is a deterministic harness under the common draft root. |
| Could the simulation mislead by using live dependencies? | No. `runCrewReferenceSimulation` records `liveNetworkCalls: []` and every boundary is mocked. |
| Could contracts be too broad? | The Pact files cover one or two consumer interactions per boundary and avoid full E2E assertions. |
| Could production writes occur without policy? | Tests assert canary writes are absent before approval and fail-closed paths do not call live-fix. |
| Could the Crew create per-agent event silos? | Events keep domain facts in existing families and use `crew.*` only for operator facts. |
| Could this conflict with other epic rollups? | Adjacent Reliability, Policy, and Progressive Delivery POCs are documented as boundaries only. |
| Could DR traffic shift without integrity proof? | The DR slice requires fencing, RPO reporting, and replay verification before ready-to-shift. |
| Could self-caused drift create runaway remediation? | The runaway guard opens a circuit and escalates before a second write. |

## POC mapping summary

Accepted POCs map to four vertical slices:

- `detect-diagnose-gate-remediate`: endpoint monitor, incident aggregate, diagnosis projection, taxonomy, runbook, policy gate, live-fix canary, integration ports, postmortem.
- `diagnose-propose-approve-remediate`: contract skew, policy approval, human operator console, A2H notifier, canary after approval.
- `detect-fail-closed-escalate`: ambiguous drift, safety gate, runaway guard, A2H handoff, issue-tracker follow-up.
- `dr-fence-replay-failover`: disaster recovery runbook, fencing, RPO honesty, replicated log replay, policy decision.

The ledger records each considered POC with disposition, status, boundaries, and contract coverage.
