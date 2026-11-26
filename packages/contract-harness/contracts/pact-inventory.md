# Pact inventory

This harness package owns no service boundary. The inventory table convention requires this file to exist even when no production boundaries are registered here.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|---|---|---|---|---|---|---|---|
| harness-inventory-boundary | HarnessInventoryGate | ContractHarnessPackage | in-process | pacts/harness-inventory-boundary.pact.json | n/a | n/a | consumer_tested |
