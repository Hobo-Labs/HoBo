# Pact Inventory

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used in simulation | Status |
|---|---|---|---|---|---|---|---|
| Cold-start sandbox validation | GenerationReferenceApp | GenerationSandboxValidation | HTTP-style request/response | `contracts/pacts/generation-sandbox-validation.pact.json`; `contracts/consumer/generation-boundaries.test.ts` | Provider unavailable; simulation uses no-egress sandbox mock | In-memory validation profile and replay report | consumer_tested |
| Certification registry publication | GenerationReferenceApp | GenerationCertificationRegistry | HTTP-style request/response | `contracts/pacts/generation-certification-registry.pact.json`; `contracts/consumer/generation-boundaries.test.ts` | Provider unavailable; simulation uses registry event mock | In-memory certification registry | consumer_tested |
| Trajectory capture store | GenerationReferenceApp | TrainingTrajectoryStore | HTTP-style request/response | `contracts/pacts/training-trajectory-store.pact.json`; `contracts/consumer/generation-boundaries.test.ts` | Provider unavailable; simulation uses event-store mock | OpenInference trajectory runtime event log | consumer_tested |
| Training promotion policy | GenerationReferenceApp | TrainingPromotionPolicyGate | HTTP-style request/response | `contracts/pacts/training-promotion-policy-gate.pact.json`; `contracts/consumer/generation-boundaries.test.ts` | Provider unavailable; simulation uses eval/policy mock | Live-eval, poisoning, and champion/challenger contract modules | consumer_tested |
| Human approval and safety gate | GenerationReferenceApp | HumanApprovalSafetyGate | HTTP-style request/response | `contracts/pacts/human-approval-safety-gate.pact.json`; `contracts/consumer/generation-boundaries.test.ts` | Provider unavailable; simulation uses approval-hook mock | Human approval and live-fix contract modules | consumer_tested |

All providers are mocked because this is a reference implementation, not the production control plane. Missing providers are documented here instead of omitting the boundary.
