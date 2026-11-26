# Generation Pipeline Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\generation-pipeline-training-ai-safety run simulate
```

What this proves:

- A database provider cold-start run reaches certification only after scaffold, LLM-fill, sandbox validation, bounded repair, safety review, and registry certification.
- A `use training` method captures OpenInference trajectories, runs the built-in OPTO optimizer, writes live-eval rewards, passes poisoning/privacy controls, and promotes through the policy gate.
- Non-converging repair, malicious generated code, poisoned labels, and production live-fix candidates fail closed or require human approval.
- A domain-record change propagates across data, business, message, intelligence, and UI generated regions without touching hand-authored code.

Mocked boundaries:

- GenerationSandboxValidation: in-memory no-egress validation profile and replay report.
- GenerationCertificationRegistry: in-memory certification event registry.
- TrainingTrajectoryStore: in-memory trajectory/event store with privacy-filtered payloads.
- TrainingPromotionPolicyGate: in-memory eval, poisoning, and champion/challenger gate.
- HumanApprovalSafetyGate: in-memory approval-hook decision for prod/high-risk changes.

Contracts:

- `contracts/pacts/generation-sandbox-validation.pact.json`
- `contracts/pacts/generation-certification-registry.pact.json`
- `contracts/pacts/training-trajectory-store.pact.json`
- `contracts/pacts/training-promotion-policy-gate.pact.json`
- `contracts/pacts/human-approval-safety-gate.pact.json`
