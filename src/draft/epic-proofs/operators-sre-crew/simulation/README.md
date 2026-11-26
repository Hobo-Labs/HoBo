# Operators & SRE Crew Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src/draft/epic-proofs/operators-sre-crew run simulate
```

What this proves:

- Provider degradation opens one incident, gates a canary, completes live-fix, and publishes replay evidence.
- Production contract skew waits for human approval before applying a shim canary.
- Ambiguous self-caused drift opens a runaway circuit and escalates without a write.
- DR failover reports fencing, RPO honesty, and replay proof before traffic shift.

Mocked boundaries:

- Endpoint Monitor -> SLO signal source: deterministic SLO burn fixture.
- SRE operator -> projection read API: deterministic diagnosis fixtures.
- SRE operator -> policy engine: deterministic allow, require-approval, and deny decisions.
- SRE operator -> remediation/live-fix gateway: deterministic canary acceptance.
- SRE operator -> A2H notifier: deterministic notify acceptance.
- SRE operator -> issue tracker port: deterministic ticket sync and follow-up creation.
- SRE operator -> knowledge port: deterministic postmortem publication.
- DR runbook -> replicated event log: deterministic fencing, RPO, and replay proof.
- Chaos orchestrator -> sandbox fault injector: contract fixture only, no live fault injection.

Contracts:

- [endpoint-monitor-slo-signals.pact.json](../contracts/pacts/endpoint-monitor-slo-signals.pact.json)
- [sre-projection-read-api.pact.json](../contracts/pacts/sre-projection-read-api.pact.json)
- [sre-policy-engine.pact.json](../contracts/pacts/sre-policy-engine.pact.json)
- [sre-remediation-gateway.pact.json](../contracts/pacts/sre-remediation-gateway.pact.json)
- [sre-a2h-notifier.pact.json](../contracts/pacts/sre-a2h-notifier.pact.json)
- [sre-issue-tracker.pact.json](../contracts/pacts/sre-issue-tracker.pact.json)
- [sre-knowledge-base.pact.json](../contracts/pacts/sre-knowledge-base.pact.json)
- [dr-replicated-event-log.pact.json](../contracts/pacts/dr-replicated-event-log.pact.json)
- [chaos-fault-injector.pact.json](../contracts/pacts/chaos-fault-injector.pact.json)
