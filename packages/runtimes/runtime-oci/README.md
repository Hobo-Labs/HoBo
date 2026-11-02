# `@hobo/runtime-oci`

Camp **component host** for `componentHost=oci`.

1. Accept prebuilt wasi:http `.wasm` (composition root builds via `@hobo/runtime-wasm`)
2. Pack as local **OCI** layout under `$HOBO_HOME/oci`
3. Schedule on **Kubernetes** via a real, minimal **kubectl transport**

## Kubectl transport (PACT boundary)

All cluster I/O goes through `KubectlTransport` — an HTTP-shaped port matching
`@hobo/contract-harness` `PactRequest` / `PactResponse`:

| Path | Role |
|------|------|
| `POST /kubectl/version` | client version probe |
| `POST /kubectl/cluster-info` | cluster reachability |
| `POST /kubectl/namespace/ensure` | ensure namespace |
| `POST /kubectl/apply` | apply manifests |
| `POST /kubectl/rollout-status` | wait for deployment |
| `POST /kubectl/port-forward` | open port-forward |
| `POST /kubectl/http-proxy` | mesh HTTP hop |
| `DELETE /kubectl/resources` | delete deployment+service |

- **Production:** `createProcessKubectlTransport()` shells out to `kubectl`
- **Tests:** `createMockProviderFromPact(pact)` from the kubectl-cluster contract

There is **no shell kubectl shim** and **no in-memory fake client class**.

```ts
import {
  createOciRuntimeHost,
  createKubectlKubernetesClient,
} from "@hobo/runtime-oci";
import { createMockProviderFromPact, loadPactDirectory } from "@hobo/contract-harness";

// production
const host = createOciRuntimeHost();

// tests
const [pact] = await loadPactDirectory("contracts/pacts");
const k8s = createKubectlKubernetesClient({
  transport: createMockProviderFromPact(pact),
});
```

Contracts: `contracts/pacts/kubectl-cluster.pact.json`, `contracts/pacts/runtime-oci-host.pact.json`.

## Env

| Variable | Role |
|----------|------|
| `HOBO_KUBECTL_BIN` | kubectl binary (process transport) |
| `KUBECONFIG` | cluster config |
| `HOBO_OCI_RUNTIME_IMAGE` | pullable image for Deployments (build [`deploy/Dockerfile`](deploy/Dockerfile)) |
