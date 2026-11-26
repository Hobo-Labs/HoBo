# runtime-oci PACT inventory

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| kubectl cluster API | RuntimeOciHost | KubernetesClusterApi | in-process HTTP-shaped | `pacts/kubectl-cluster.pact.json` / `consumer/kubectl-cluster.contract.test.ts` | `provider/kubectl-cluster.provider.test.ts` | `createMockProviderFromPact` | provider_verified |
| oci camp host | HoboCompositionRoot | RuntimeOciHost | in-process HTTP-shaped | `pacts/runtime-oci-host.pact.json` / `consumer/runtime-oci-host.contract.test.ts` | `provider/runtime-oci-host.provider.test.ts` | `createMockProviderFromPact` | provider_verified |
