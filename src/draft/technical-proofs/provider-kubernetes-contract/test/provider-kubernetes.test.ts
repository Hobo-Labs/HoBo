import assert from "node:assert/strict";
import { test } from "vitest";

import { hoboVerify, runProviderCapabilitySuites } from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { validateEmission } from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  KUBERNETES_PROVIDER_ID,
  createKubernetesClusterFixturePlan,
  createKubernetesProvider,
  evaluateKubernetesPlan,
  kubernetes,
  mergeKubernetesResolvedOptions,
  realizeKubernetesPlan,
  simulateKubernetesApply
} from "../src/provider-kubernetes.js";

test("factory publishes Kubernetes compute, runtime-host, networking, and in-cluster defaults", () => {
  const provider = createKubernetesProvider();
  const manifest = provider.capabilityManifest();
  const registry = [];

  provider.registerDefaultDefinitions(registry);

  assert.equal(provider.id, KUBERNETES_PROVIDER_ID);
  assert.deepEqual(provider.manifest.claimedCapabilities, ["compute", "database", "cache"]);
  assert.deepEqual(
    Object.keys(provider.with).sort(),
    ["deployment", "ingress", "namespace", "postgres", "redis", "service", "wasmCloudHost"]
  );
  assert.deepEqual(
    registry.map((definition) => [definition.id, definition.port, definition.resourceClass, definition.driver]),
    [
      ["k8s.default.compute.deployment", "compute", "k8s:deployment", "@hobo/iac-crossplane"],
      ["k8s.default.networking.service", "networking", "k8s:service", "@hobo/iac-crossplane"],
      ["k8s.default.networking.ingress", "networking", "k8s:ingress", "@hobo/iac-crossplane"],
      ["k8s.default.component-host.wasmcloud", "componentHost", "k8s:wasmcloud-operator", "@hobo/iac-crossplane"],
      ["k8s.default.database.postgres", "database", "k8s:postgres-statefulset", "@hobo/iac-crossplane"],
      ["k8s.default.cache.redis", "cache", "k8s:redis-statefulset", "@hobo/iac-crossplane"]
    ]
  );
  assert.equal(manifest.provider, KUBERNETES_PROVIDER_ID);
  assert.equal(manifest.runtimeHosts[0].kind, "wasmcloud-operator");
  assert.equal(manifest.networking.serviceDiscovery, "kubernetes-service-dns");
  assert.equal(manifest.auth.mode, "svid-federation");
  assert.equal(manifest.capabilities.find((capability) => capability.port === "compute").resourceClass, "k8s:deployment");
});

test("Kubernetes provider passes local and camp provider-capability conformance for claimed seed ports", () => {
  const provider = createKubernetesProvider({ campEvidence: "pass" });
  const capabilities = provider.capabilityManifest().claimedCapabilities;
  const report = runProviderCapabilitySuites(provider, {
    capabilities,
    tags: ["local", "camp"]
  });
  const verify = hoboVerify(provider, {
    capabilities,
    runTags: ["local", "camp"],
    claimProdReady: true
  });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.coverage.local.capabilities, [...capabilities].sort());
  assert.deepEqual(report.coverage.camp.capabilities, [...capabilities].sort());
  assert.equal(verify.status, "pass");
  assert.equal(verify.prodReady.status, "pass");
});

test("fixture realizes workload, Service, in-cluster Postgres, Redis, and wasmCloud host substrate", () => {
  const provider = createKubernetesProvider();
  const plan = createKubernetesClusterFixturePlan({ namespace: "preview-a" });
  const emission = realizeKubernetesPlan(provider, plan);
  const validation = validateEmission(emission);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(emission.provider, KUBERNETES_PROVIDER_ID);
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.resourceClass, node.driverIntent.iacProvider]),
    [
      ["app-namespace", "k8s:namespace", "@hobo/iac-crossplane"],
      ["orders-db", "k8s:postgres-statefulset", "@hobo/iac-crossplane"],
      ["session-cache", "k8s:redis-statefulset", "@hobo/iac-crossplane"],
      ["web", "k8s:deployment", "@hobo/iac-crossplane"],
      ["web-service", "k8s:service", "@hobo/iac-crossplane"],
      ["web-ingress", "k8s:ingress", "@hobo/iac-crossplane"],
      ["wasmcloud-host", "k8s:wasmcloud-operator", "@hobo/iac-crossplane"]
    ]
  );
  assert.equal(emission.iac.links.length, 3);
  assert.equal(emission.iac.nodes.find((node) => node.id === "web").inputs.env.ORDERS_DB_CONNECTION.startsWith("${resources.database"), true);
  assert.equal(emission.iac.nodes.find((node) => node.id === "wasmcloud-host").inputs.options.lattice, "preview-a");
  assert.equal(emission.portabilityReport.entries.length, 0);
});

test("provider-scoped .with blocks only affect Kubernetes-resolved resources", () => {
  const provider = createKubernetesProvider();
  const merged = mergeKubernetesResolvedOptions(provider, [
    kubernetes.with.deployment({ replicas: 3, runtimeClassName: "wasmtime" }),
    { providerId: "gcp", port: "compute", optionName: "cloudRun", negotiation: "prefer", options: { minInstances: 1 } }
  ]);
  const emission = realizeKubernetesPlan(
    provider,
    createKubernetesClusterFixturePlan({
      resourceOptions: {
        web: [kubernetes.with.deployment({ replicas: 3, runtimeClassName: "wasmtime" })],
        "web-service": [kubernetes.with.service({ type: "ClusterIP" })],
        "wasmcloud-host": [kubernetes.with.wasmCloudHost({ replicas: 2, nats: "helm-bundled" })]
      }
    })
  );

  assert.equal(merged.merged.compute.optionName, "deployment");
  assert.equal(merged.dropped[0].providerId, "gcp");
  assert.equal(emission.iac.nodes.find((node) => node.id === "web").inputs.options.replicas, 3);
  assert.equal(emission.iac.nodes.find((node) => node.id === "web-service").inputs.options.type, "ClusterIP");
  assert.equal(emission.iac.nodes.find((node) => node.id === "wasmcloud-host").inputs.options.replicas, 2);
});

test("missing operator CRDs, capacity exhaustion, drift, and namespace/RBAC conflicts reject precisely", () => {
  const missingOperator = evaluateKubernetesPlan(
    createKubernetesProvider({
      cluster: {
        installedCrds: [
          "v1/Namespace",
          "apps/v1/Deployment",
          "v1/Service",
          "networking.k8s.io/v1/Ingress",
          "acid.zalan.do/v1/Postgresql",
          "redis.redis.opstreelabs.in/v1beta2/Redis"
        ]
      }
    }),
    createKubernetesClusterFixturePlan()
  );
  assert.equal(missingOperator.type, "deployment.PlanRejected");
  assert.equal(missingOperator.reason.code, "k8s-required-crd-missing");
  assert.equal(missingOperator.reason.resourceId, "wasmcloud-host");

  const capacity = simulateKubernetesApply(createKubernetesProvider(), createKubernetesClusterFixturePlan(), {
    capacity: { cpuMillicores: 250, memoryMiB: 256 }
  });
  assert.equal(capacity.type, "deployment.PlanRejected");
  assert.equal(capacity.reason.code, "k8s-cluster-capacity-exhausted");
  assert.equal(capacity.reason.resourceId, "web");

  const drift = simulateKubernetesApply(createKubernetesProvider(), createKubernetesClusterFixturePlan(), {
    clusterDrift: { "web-service": true }
  });
  assert.equal(drift.type, "deployment.PlanRejected");
  assert.equal(drift.reason.code, "k8s-crossplane-drift-detected");
  assert.equal(drift.reason.resourceId, "web-service");

  const rbacConflict = evaluateKubernetesPlan(
    createKubernetesProvider({ cluster: { namespaces: { "preview-a": { tenant: "tenant-b" } } } }),
    createKubernetesClusterFixturePlan({ tenant: "tenant-a", namespace: "preview-a" })
  );
  assert.equal(rbacConflict.type, "deployment.PlanRejected");
  assert.equal(rbacConflict.reason.code, "k8s-namespace-rbac-boundary");
  assert.match(rbacConflict.reason.message, /tenant-b/);
});
