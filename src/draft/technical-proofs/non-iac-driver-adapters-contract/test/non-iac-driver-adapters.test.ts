import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  createDriverDispatchRouter,
  createFixtureResource
} from "../../driver-dispatch-routing-contract/src/driver-dispatch-routing.js";
import { defineResource } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import {
  NonIacDriverAdapterError,
  createContainerDriverAdapter,
  createCustomWebhookDriverAdapter,
  createEchoDriverAdapter,
  createFixtureContainerExecutor,
  createFixtureWebhookService,
  createNonIacDriverAdapters,
  createTemplateDriverAdapter,
  selectDriverForResourceDefinition
} from "../src/non-iac-driver-adapters.js";

test("type declarations publish the non-IaC adapter surface", () => {
  const declarations = readFileSync(
    new URL("../src/non-iac-driver-adapters.d.ts", import.meta.url),
    "utf8"
  );

  assert.match(declarations, /export declare function createTemplateDriverAdapter/);
  assert.match(declarations, /export declare function createEchoDriverAdapter/);
  assert.match(declarations, /export declare function createContainerDriverAdapter/);
  assert.match(declarations, /export declare function createCustomWebhookDriverAdapter/);
  assert.match(declarations, /export declare function selectDriverForResourceDefinition/);
  assert.match(declarations, /export type ContainerExecutorRequest/);
  assert.match(declarations, /export type WebhookRequest/);
  assert.match(declarations, /export declare function signSvidRequest/);
  assert.match(declarations, /export declare function verifySvidRequest/);
});

test("all non-IaC adapters are selectable by Resource Definition driver id", () => {
  const adapters = createNonIacDriverAdapters({
    container: { executor: createFixtureContainerExecutor() },
    webhook: {
      secret: "fixture-webhook-secret",
      service: createFixtureWebhookService({ secret: "fixture-webhook-secret" })
    }
  });

  for (const driver of ["template", "echo", "container", "custom-webhook"]) {
    const definition = defineResource({
      id: `fixture.${driver}.cache`,
      type: "cache",
      engine: "redis",
      provider: "fixture-provider",
      driver,
      match: { envType: "preview" }
    });

    assert.equal(selectDriverForResourceDefinition(definition, adapters).id, driver);
  }

  assert.throws(
    () =>
      selectDriverForResourceDefinition(
        defineResource({
          id: "fixture.terraform.cache",
          type: "cache",
          engine: "redis",
          provider: "fixture-provider",
          driver: "terraform",
          match: {}
        }),
        adapters
      ),
    /driver terraform is not registered/
  );
});

test("template driver renders a fixture Kubernetes manifest set", async () => {
  const driver = createTemplateDriverAdapter();
  const definition = defineResource({
    id: "kubernetes.template.api",
    type: "workload",
    provider: "kubernetes",
    driver: "template",
    with: {
      manifests: [
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "${context.app}-${context.env}-config" },
          data: {
            DATABASE_URL: "${resources.database.postgres#primary.outputs.url}"
          }
        },
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "${context.app}" },
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: "api",
                    image: "${inputs.image}",
                    env: [
                      {
                        name: "DATABASE_URL",
                        value: "${resources.database.postgres#primary.outputs.url}"
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
      ]
    },
    match: { env: "preview" }
  });

  const result = await driver.provision({
    context: { app: "orders", env: "preview" },
    inputs: {
      definition,
      image: "registry.example/orders:2026-06-27",
      resources: {
        "database.postgres#primary": {
          outputs: {
            url: "postgres://orders-db.internal:5432/orders"
          }
        }
      }
    }
  });

  assert.equal(result.outputs.manifestCount, 2);
  assert.match(result.outputs.renderedDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.manifests[0], {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "orders-preview-config" },
    data: {
      DATABASE_URL: "postgres://orders-db.internal:5432/orders"
    }
  });
  assert.equal(
    result.manifests[1].spec.template.spec.containers[0].image,
    "registry.example/orders:2026-06-27"
  );
});

test("managed adapter outputs flow back through events and dependent placeholders", async () => {
  const definition = defineResource({
    id: "kubernetes.template.manifest-set",
    type: "manifest-set",
    provider: "kubernetes",
    driver: "template",
    with: {
      manifests: [
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "${context.app}-config" },
          data: { endpoint: "${resources.database.postgres#primary.outputs.url}" }
        }
      ]
    },
    match: { env: "preview" }
  });
  const router = createDriverDispatchRouter({
    drivers: [createTemplateDriverAdapter()]
  });

  const result = await router.provision({
    definition,
    resource: createFixtureResource("manifest-set", { type: "manifest-set" }),
    context: { app: "orders", env: "preview" },
    inputs: {
      manifests: definition.with.manifests,
      resources: {
        "database.postgres#primary": {
          outputs: {
            url: "postgres://orders-db.internal:5432/orders"
          }
        }
      }
    },
    dependents: [
      {
        resourceId: "api",
        placeholders: {
          MANIFEST_DIGEST: { from: "manifest-set", output: "renderedDigest" }
        }
      }
    ]
  });

  assert.equal(result.status, "provisioned");
  assert.equal(result.provisioned.type, "resource.Provisioned");
  assert.equal(result.provisioned.data.outputs.manifestCount, 1);
  assert.match(result.provisioned.data.outputs.renderedDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.resolvedDependents, [
    {
      resourceId: "api",
      values: {
        MANIFEST_DIGEST: result.provisioned.data.outputs.renderedDigest
      }
    }
  ]);
});

test("template driver rejects unresolved placeholders", async () => {
  const driver = createTemplateDriverAdapter();

  await assert.rejects(
    () =>
      driver.provision({
        context: { app: "orders" },
        inputs: {
          manifests: [
            {
              kind: "SecretlessConfig",
              data: { password: "${resources.database.postgres#primary.outputs.password}" }
            }
          ],
          resources: {
            "database.postgres#primary": {
              outputs: {
                url: "postgres://orders-db.internal:5432/orders"
              }
            }
          }
        }
      }),
    (error) => {
      assert.ok(error instanceof NonIacDriverAdapterError);
      assert.equal(error.code, "unresolved-template-placeholder");
      assert.match(error.message, /database\.postgres#primary\.outputs\.password/);
      return true;
    }
  );
});

test("echo driver passes declared connection outputs through and reports drift only", async () => {
  const driver = createEchoDriverAdapter();
  const connection = {
    url: "postgres://byo-db.internal:5432/orders",
    credentialRef: "secret://orders/byo-db/password"
  };

  const provisioned = await driver.provision({
    context: { tenant: "tenant-a", env: "preview" },
    inputs: { connection }
  });

  assert.deepEqual(provisioned.outputs, connection);
  assert.deepEqual(provisioned.manifests, []);
  assert.deepEqual(provisioned.state, { readOnly: true, outputs: connection });

  const refreshed = await driver.refresh({
    context: { tenant: "tenant-a", env: "preview" },
    state: provisioned.state,
    inputs: {
      connection: {
        ...connection,
        url: "postgres://moved-db.internal:5432/orders"
      }
    }
  });

  assert.equal(refreshed.drift.mode, "read-only");
  assert.equal(refreshed.drift.changed, true);
  assert.equal(refreshed.provisioningAttempted, false);
  assert.deepEqual(refreshed.outputs, {
    ...connection,
    url: "postgres://moved-db.internal:5432/orders"
  });
});

test("echo driver rejects mutation attempts by default", async () => {
  const driver = createEchoDriverAdapter();

  await assert.rejects(
    () =>
      driver.provision({
        context: {},
        inputs: {
          connection: { url: "postgres://byo-db.internal:5432/orders" },
          mutation: { action: "create" }
        }
      }),
    (error) => {
      assert.ok(error instanceof NonIacDriverAdapterError);
      assert.equal(error.code, "echo-read-only");
      return true;
    }
  );
});

test("container driver runs a fixture provisioning script in a sandboxed Executor", async () => {
  const executor = createFixtureContainerExecutor();
  const driver = createContainerDriverAdapter({ executor });

  const result = await driver.provision({
    context: { tenant: "tenant-a", env: "preview", correlationId: "corr-container-1" },
    inputs: {
      script: {
        id: "provision-search-index",
        command: "node provision-search-index.ts",
        egress: ["https://search.internal"],
        outputs: {
          endpoint: "https://search.internal/index/orders",
          credentialRef: "secret://orders/search"
        }
      },
      sandbox: {
        image: "ghcr.io/hobo/driver-runner:sha256-fixture",
        allowedEgress: ["https://search.internal"]
      }
    }
  });

  assert.deepEqual(result.outputs, {
    endpoint: "https://search.internal/index/orders",
    credentialRef: "secret://orders/search"
  });
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].script.id, "provision-search-index");
  assert.deepEqual(executor.calls[0].sandbox.network.allowedEgress, ["https://search.internal"]);
  assert.match(result.state.sandboxDigest, /^[a-f0-9]{64}$/);
});

test("container driver denies script egress beyond the scoped sandbox target", async () => {
  const executor = createFixtureContainerExecutor();
  const driver = createContainerDriverAdapter({ executor });

  await assert.rejects(
    () =>
      driver.provision({
        context: {},
        inputs: {
          script: {
            id: "exfiltrate",
            command: "node bad.ts",
            egress: ["https://search.internal", "https://metadata.internal"],
            outputs: {}
          },
          sandbox: {
            allowedEgress: ["https://search.internal"]
          }
        }
      }),
    (error) => {
      assert.ok(error instanceof NonIacDriverAdapterError);
      assert.equal(error.code, "container-egress-denied");
      assert.match(error.message, /https:\/\/metadata\.internal/);
      return true;
    }
  );
  assert.equal(executor.calls.length, 0);
});

test("custom-webhook driver makes a signed SVID request to a fixture service", async () => {
  const service = createFixtureWebhookService({
    secret: "fixture-webhook-secret",
    outputs: {
      endpoint: "https://webhook-resource.internal",
      credentialRef: "secret://custom-webhook/resource"
    }
  });
  const driver = createCustomWebhookDriverAdapter({
    secret: "fixture-webhook-secret",
    service,
    svid: "spiffe://hobo.test/ns/providers/sa/custom-webhook-driver"
  });

  const result = await driver.provision({
    context: { tenant: "tenant-a", env: "preview" },
    inputs: {
      body: {
        resource: "external-search",
        planId: "plan-custom-webhook-1"
      }
    }
  });

  assert.deepEqual(result.outputs, {
    endpoint: "https://webhook-resource.internal",
    credentialRef: "secret://custom-webhook/resource"
  });
  assert.equal(service.requests.length, 1);
  assert.equal(
    service.requests[0].headers["x-hobo-svid"],
    "spiffe://hobo.test/ns/providers/sa/custom-webhook-driver"
  );
  assert.match(service.requests[0].headers["x-hobo-signature"], /^[a-f0-9]{64}$/);
});

test("custom-webhook driver rejects an invalid or forged SVID signature", async () => {
  const service = createFixtureWebhookService({ secret: "fixture-webhook-secret" });
  const driver = createCustomWebhookDriverAdapter({
    secret: "fixture-webhook-secret",
    service,
    signer() {
      return {
        svid: "spiffe://hobo.test/ns/providers/sa/custom-webhook-driver",
        signature: "forged"
      };
    }
  });

  await assert.rejects(
    () =>
      driver.provision({
        context: { tenant: "tenant-a", env: "preview" },
        inputs: { body: { resource: "external-search" } }
      }),
    (error) => {
      assert.ok(error instanceof NonIacDriverAdapterError);
      assert.equal(error.code, "invalid-svid-signature");
      return true;
    }
  );
});
