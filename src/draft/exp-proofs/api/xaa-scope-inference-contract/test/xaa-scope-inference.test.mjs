import assert from "node:assert/strict";
import { test } from "vitest";

import { createConnectorBinding } from "../../../../technical-proofs/connector-authoring-contract/src/connector-authoring.mjs";
import { inferConnectorScopes } from "../src/xaa-scope-inference.mjs";

const asanaAuth = {
  issuer: "https://asana.example.com",
  flows: [
    {
      type: "oauth2-xaa",
      idJag: true,
      authorizationServer: "https://asana.example.com/oauth",
      audience: "urn:asana:app",
      scopes: ["tasks:read", "tasks:write"],
      resourceIndicators: ["urn:asana:tasks"],
      operations: {
        "tasks.get": { scope: "tasks:read" },
        "tasks.create": { scope: "tasks:write" },
      },
    },
  ],
};

test("infers least-privilege XAA allow from called connector operations", () => {
  const result = inferConnectorScopes({
    sourceText: `
      import { connector } from "@hobo/bindles";
      const asana = connector("asana");
      export async function sync(ctx) {
        await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });
      }
    `,
    bindings: {
      asana: createConnectorBinding("asana", asanaAuth),
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.observedOperations, [
    {
      target: "asana",
      operation: "tasks.create",
      scope: "tasks:write",
      line: 5,
      onBehalfOf: "user",
    },
  ]);
  assert.deepEqual(result.manifest.connectors.asana.allow, ["tasks:write"]);
  assert.deepEqual(result.manifest.connectors.asana.observedScopes, ["tasks:write"]);
  assert.equal(result.manifest.connectors.asana.onBehalfOf, "user");
  assert.equal(result.manifest.connectors.asana.onBehalfOf === "app", false);
  assert.equal(result.manifest.connectors.asana.allow.includes("tasks:read"), false);
});

test("records a can-deploy contract failure when .allow narrows below observed usage", () => {
  const result = inferConnectorScopes({
    sourceText: `
      import { connector } from "@hobo/bindles";
      const asana = connector("asana").allow("tasks:read");
      export async function sync(ctx) {
        await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });
      }
    `,
    bindings: {
      asana: createConnectorBinding("asana", asanaAuth).allow("tasks:read"),
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.manifest.connectors.asana.allow, ["tasks:read"]);
  assert.deepEqual(result.manifest.connectors.asana.observedScopes, ["tasks:write"]);
  assert.deepEqual(result.contractFailures, [
    {
      code: "xaa.scope.exceeds-declared-allow",
      severity: "error",
      target: "asana",
      allowedScopes: ["tasks:read"],
      observedScopes: ["tasks:write"],
      message: "connector asana observes scopes outside declared .allow().",
    },
  ]);
});

test("keeps deny-by-default for unused advertised scopes", () => {
  const result = inferConnectorScopes({
    sourceText: `
      import { connector } from "@hobo/bindles";
      const asana = connector("asana");
      export async function readOnly(ctx) {
        await asana.tasks.get({ id: ctx.params.id, assignee: ctx.user.id });
      }
    `,
    bindings: {
      asana: createConnectorBinding("asana", asanaAuth),
    },
  });

  assert.deepEqual(result.manifest.connectors.asana.allow, ["tasks:read"]);
  assert.equal(result.manifest.connectors.asana.allow.includes("tasks:write"), false);
});

test("fails closed for unadvertised called operations", () => {
  const result = inferConnectorScopes({
    sourceText: `
      import { connector } from "@hobo/bindles";
      const asana = connector("asana");
      export async function destroy(ctx) {
        await asana.tasks.delete({ id: ctx.params.id, assignee: ctx.user.id });
      }
    `,
    bindings: {
      asana: createConnectorBinding("asana", asanaAuth),
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics, [
    {
      code: "xaa.scope.unadvertised-operation",
      severity: "error",
      target: "asana",
      operation: "tasks.delete",
      line: 5,
      message: "connector asana operation tasks.delete is not advertised by auth.json.",
    },
  ]);
  assert.deepEqual(result.manifest.connectors.asana.allow, []);
});

test("downgrades dynamically-constructed operation names to coverage failure", () => {
  const result = inferConnectorScopes({
    sourceText: `
      import { connector } from "@hobo/bindles";
      const asana = connector("asana");
      export async function dynamic(ctx, method) {
        await asana.tasks[method]({ assignee: ctx.user.id });
      }
    `,
    bindings: {
      asana: createConnectorBinding("asana", asanaAuth),
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics, [
    {
      code: "xaa.scope.cannot-prove-operation",
      severity: "error",
      target: "asana",
      operationPrefix: "tasks",
      line: 5,
      message: "Static analysis cannot prove connector asana operation under tasks; XAA scope inference must fail closed.",
    },
  ]);
  assert.deepEqual(result.manifest.connectors.asana.allow, []);
});

test("fails closed if an operation maps outside the target advertised scopes", () => {
  const result = inferConnectorScopes({
    sourceText: `
      import { connector } from "@hobo/bindles";
      const asana = connector("asana");
      export async function sync(ctx) {
        await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });
      }
    `,
    bindings: {
      asana: {
        name: "asana",
        flow: { audience: "urn:asana:app" },
        via: "xaa",
        advertisedScopes: ["tasks:read"],
        operationScopes: { "tasks.create": "tasks:write" },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics, [
    {
      code: "xaa.scope.unadvertised-scope",
      severity: "error",
      target: "asana",
      operation: "tasks.create",
      scope: "tasks:write",
      line: 5,
      message: "connector asana operation tasks.create maps to unadvertised scope tasks:write.",
    },
  ]);
  assert.deepEqual(result.manifest.connectors.asana.allow, []);
});
