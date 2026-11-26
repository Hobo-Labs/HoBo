import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DriverDispatchError,
  createDriverDispatchRouter,
  createFixtureDriver,
  createFixtureResource
} from "../src/driver-dispatch-routing.js";

const DRIVER_IDS = ["terraform", "template", "container", "custom-webhook"];

test("routes managed driver ids to the named fake driver through the Executor seam", async () => {
  for (const driverId of DRIVER_IDS) {
    const driver = createFixtureDriver(driverId, {
      outputs: { endpoint: `${driverId}://db.internal`, passwordRef: "secret://db/password" },
      manifests: [{ kind: `${driverId}.manifest`, name: "db" }],
      state: { stackId: `${driverId}-stack-db` }
    });
    const router = createDriverDispatchRouter({ drivers: [driver] });

    const result = await router.provision({
      definition: { id: `definition.${driverId}.db`, provider: "fixture-cloud", driver: driverId },
      resource: createFixtureResource("db"),
      context: { tenant: "tenant-a", env: "prod", resourceId: "db" },
      inputs: { plan: "managed-db" },
      dependents: [
        {
          resourceId: "api",
          placeholders: {
            DB_URL: { from: "db", output: "endpoint" },
            DB_PASSWORD_REF: { from: "db", output: "passwordRef" }
          }
        }
      ]
    });

    assert.equal(result.status, "provisioned");
    assert.equal(driver.calls.provision.length, 1);
    assert.equal(driver.calls.provision[0].oldState, undefined);
    assert.equal(Object.hasOwn(driver.calls.provision[0], "oldState"), false);
    assert.ok(result.events.some((event) => event.type === "exec.Started"));
    assert.ok(result.events.some((event) => event.type === "exec.Succeeded"));
    assert.deepEqual(result.provisioned.data.outputs, {
      endpoint: `${driverId}://db.internal`,
      passwordRef: "secret://db/password"
    });
    assert.deepEqual(result.resolvedDependents, [
      {
        resourceId: "api",
        values: {
          DB_URL: `${driverId}://db.internal`,
          DB_PASSWORD_REF: "secret://db/password"
        }
      }
    ]);
  }
});

test("echo driver passes declared connection info through without provisioning", async () => {
  const echo = createFixtureDriver("echo", {
    outputs: { endpoint: "should-not-be-called" }
  });
  const router = createDriverDispatchRouter({ drivers: [echo] });

  const result = await router.provision({
    definition: { id: "definition.echo.db", provider: "byo", driver: "echo" },
    resource: createFixtureResource("db"),
    context: { tenant: "tenant-a", env: "preview", resourceId: "db" },
    inputs: {
      connection: {
        endpoint: "postgres://byo-db.internal",
        credentialRef: "secret://byo-db/password"
      }
    }
  });

  assert.equal(result.status, "provisioned");
  assert.equal(result.readOnly, true);
  assert.equal(echo.calls.provision.length, 0);
  assert.ok(!result.events.some((event) => event.type.startsWith("exec.")));
  assert.deepEqual(result.provisioned.data.outputs, {
    endpoint: "postgres://byo-db.internal",
    credentialRef: "secret://byo-db/password"
  });
});

test("echo refresh records read-only drift without provisioning", async () => {
  const echo = createFixtureDriver("echo", {
    outputs: { endpoint: "should-not-be-called" }
  });
  const router = createDriverDispatchRouter({ drivers: [echo] });

  const result = await router.refresh({
    definition: { id: "definition.echo.db", provider: "byo", driver: "echo" },
    resource: createFixtureResource("db"),
    context: { tenant: "tenant-a", env: "preview", resourceId: "db" },
    inputs: {
      connection: {
        endpoint: "postgres://changed-db.internal",
        credentialRef: "secret://byo-db/password"
      }
    },
    state: {
      outputs: {
        endpoint: "postgres://byo-db.internal",
        credentialRef: "secret://byo-db/password"
      }
    }
  });

  assert.equal(result.status, "refreshed");
  assert.equal(result.readOnly, true);
  assert.equal(echo.calls.refresh.length, 0);
  assert.equal(result.drift.mode, "read-only");
  assert.equal(result.drift.changed, true);
  assert.deepEqual(result.event.data.outputs, {
    endpoint: "postgres://changed-db.internal",
    credentialRef: "secret://byo-db/password"
  });
});

test("unknown driver ids are rejected before dispatch", async () => {
  const router = createDriverDispatchRouter({ drivers: [] });

  await assert.rejects(
    () =>
      router.provision({
        definition: { id: "definition.cloudformation.db", provider: "fixture", driver: "cloudformation" },
        resource: createFixtureResource("db"),
        context: { tenant: "tenant-a", env: "prod", resourceId: "db" },
        inputs: {}
      }),
    (error) => {
      assert.ok(error instanceof DriverDispatchError);
      assert.equal(error.code, "unknown-driver");
      assert.match(error.message, /cloudformation/);
      return true;
    }
  );
});

test("driver manifests without outputs fail closed before resource.Provisioned", async () => {
  const router = createDriverDispatchRouter({
    drivers: [
      createFixtureDriver("template", {
        outputs: undefined,
        manifests: [{ kind: "manifest", name: "db" }]
      })
    ]
  });

  const result = await router.provision({
    definition: { id: "definition.template.db", provider: "fixture", driver: "template" },
    resource: createFixtureResource("db"),
    context: { tenant: "tenant-a", env: "prod", resourceId: "db" },
    inputs: {}
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "missing-driver-outputs");
  assert.ok(!result.events.some((event) => event.type === "resource.Provisioned"));
  assert.ok(result.events.some((event) => event.type === "resource.Failed"));
});

test("custom-webhook timeout is classified as retryable resource.Failed", async () => {
  const router = createDriverDispatchRouter({
    drivers: [
      createFixtureDriver("custom-webhook", {
        fail: Object.assign(new Error("webhook timed out after 30s"), { code: "ETIMEDOUT" })
      })
    ]
  });

  const result = await router.provision({
    definition: { id: "definition.webhook.db", provider: "fixture", driver: "custom-webhook" },
    resource: createFixtureResource("db"),
    context: { tenant: "tenant-a", env: "prod", resourceId: "db" },
    inputs: {}
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.classification, "retryable");
  assert.match(result.failure.reason, /timed out/);
  assert.equal(result.events.at(-1).type, "resource.Failed");
});

test("destroy and refresh are routed to the selected driver with old state", async () => {
  const driver = createFixtureDriver("terraform", {
    refreshState: { drift: false, outputs: { endpoint: "terraform://db.internal" } }
  });
  const router = createDriverDispatchRouter({ drivers: [driver] });
  const definition = { id: "definition.terraform.db", provider: "fixture-cloud", driver: "terraform" };
  const resource = createFixtureResource("db");
  const context = { tenant: "tenant-a", env: "prod", resourceId: "db" };
  const state = { stackId: "terraform-stack-db" };

  const refresh = await router.refresh({ definition, resource, context, state });
  const destroy = await router.destroy({ definition, resource, context, state });

  assert.deepEqual(refresh.state, { drift: false, outputs: { endpoint: "terraform://db.internal" } });
  assert.equal(destroy.status, "destroyed");
  assert.deepEqual(driver.calls.refresh[0].state, state);
  assert.deepEqual(driver.calls.destroy[0].state, state);
});

test("destroy does not emit resource.Destroyed when the Executor fails", async () => {
  const driver = createFixtureDriver("terraform", {});
  const router = createDriverDispatchRouter({
    drivers: [driver],
    executor: {
      async dispatch() {
        return {
          status: "failed",
          classification: "fatal",
          reason: "fatal: destroy command failed",
          execId: "exec-terraform-db-destroy",
          events: [
            {
              id: "evt-exec-failed",
              type: "exec.Failed",
              data: { execId: "exec-terraform-db-destroy" }
            }
          ]
        };
      }
    }
  });

  const result = await router.destroy({
    definition: { id: "definition.terraform.db", provider: "fixture-cloud", driver: "terraform" },
    resource: createFixtureResource("db"),
    context: { tenant: "tenant-a", env: "prod", resourceId: "db" },
    state: { stackId: "terraform-stack-db" }
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "executor-failed");
  assert.ok(result.events.some((event) => event.type === "exec.Failed"));
  assert.ok(result.events.some((event) => event.type === "resource.Failed"));
  assert.ok(!result.events.some((event) => event.type === "resource.Destroyed"));
});
