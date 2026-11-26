# Pact Inventory

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used in simulation | Status |
|---|---|---|---|---|---|---|---|
| Artifact repository mirror | Registry reference app | `hobo:artifact-repo` mirror adapter | request-response | `contracts/pacts/registry-artifact-repository.pact.json` / `contracts/consumer/registry-boundaries.test.ts` | Mock provider verifies digest-pinned pull shape | In-memory mirror fixtures | consumer_tested |
| Capability discovery index | Registry reference app | Registry discovery projection | request-response | `contracts/pacts/registry-capability-discovery.pact.json` / `contracts/consumer/registry-boundaries.test.ts` | Mock provider verifies certified listing query/result shape | In-memory lifecycle projection | consumer_tested |
| Trust and policy gate | Registry reference app | Install verifier plus trust/catalog/yank policy | message | `contracts/pacts/registry-trust-policy.pact.json` / `contracts/consumer/registry-boundaries.test.ts` | Built-in provider exists as pure POC functions; verified by simulation assertions | Deterministic fixture keys and policies | provider_verified |
| Offline import | Registry reference app | Bundle importer and in-boundary mirror | message | `contracts/pacts/registry-offline-import.pact.json` / `contracts/consumer/registry-boundaries.test.ts` | Mock provider verifies BundleImported event and no egress | In-boundary mirror fixture | consumer_tested |
