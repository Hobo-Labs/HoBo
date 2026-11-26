import { createKubernetesClusterFixturePlan, createKubernetesProvider, kubernetes, type KubernetesProvider } from "@hobo-draft/provider-kubernetes-contract";
import { type JsonObject } from "../src/json.js";


const provider: KubernetesProvider = createKubernetesProvider();
const deployment = kubernetes.with.deployment({ replicas: 2, runtimeClassName: "wasmtime" });
const service = kubernetes.with.service({ type: "ClusterIP" });
const host = kubernetes.with.wasmCloudHost({ nats: "helm-bundled", replicas: 2 });
const manifest = provider.capabilityManifest();
const client = provider.client("compute", {
  url: "http://web.preview-a.svc.cluster.local",
  serviceName: "web"
});
const emission = provider.realize(createKubernetesClusterFixturePlan());

deployment.options.replicas satisfies number;
deployment.options.runtimeClassName satisfies "wasmtime" | "runc";
service.options.type satisfies "ClusterIP" | "LoadBalancer";
host.options.nats satisfies "helm-bundled" | "external";
client.url satisfies string;
emission satisfies JsonObject;
manifest.runtimeHosts[0].kind satisfies "wasmcloud-operator";

// @ts-expect-error Deployment options reject untyped raw manifest escape hatches.
kubernetes.with.deployment({ rawKubernetesManifest: { kind: "Deployment" } });

// @ts-expect-error client is typed to declared Kubernetes seed ports only.
provider.client("queue", {});
