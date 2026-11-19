# Pact inventory

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|---|---|---|---|---|---|---|---|
| core-scaffold-boundary | WorkspaceSkeleton | CoreScaffoldBoundary | in-process | pacts/core-scaffold-boundary.pact.json | test/core-contract-boundary.contract.test.ts | n/a | consumer_tested |
| core-contract-surface | CoreReferenceConsumer | CoreContractSurface | in-process | pacts/core-contract-surface.pact.json | n/a | createMockProviderFromPact | consumer_tested |
