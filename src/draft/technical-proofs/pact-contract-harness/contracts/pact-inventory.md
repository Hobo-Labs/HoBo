# Pact inventory

This harness proof owns no service boundary. The table below documents the reference core-contract-surface boundary exercised by this draft POC.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|---|---|---|---|---|---|---|---|
| core-contract-surface | CoreReferenceConsumer | CoreContractSurface | in-process | pacts/core-contract-surface.pact.json | provider/core-contract-surface.provider.test.ts | core-contract-surface.stub.ts | provider_verified |
