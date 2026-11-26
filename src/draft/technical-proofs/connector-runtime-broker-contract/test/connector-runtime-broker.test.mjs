import assert from "node:assert/strict";
import { test } from "vitest";

import { createConnectorBinding } from "../../connector-authoring-contract/src/connector-authoring.mjs";
import { inferConnectorScopes } from "../../../exp-proofs/api/xaa-scope-inference-contract/src/xaa-scope-inference.mjs";
import { parseJwtBearerGrantRequest } from "../../id-jag-token-exchange-contract/src/id-jag-token-exchange.ts";
import { createOutboundXaaTokenBroker } from "../../outbound-xaa-token-exchange-contract/src/outbound-xaa-token-exchange.ts";
import { createConnectorRuntime } from "../src/connector-runtime-broker.mjs";

const FIXED_NOW = new Date("2026-06-27T21:50:00.000Z");
const FIXED_EPOCH = Math.floor(FIXED_NOW.getTime() / 1000);
const SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const ASANA_TARGET = Object.freeze({
  id: "asana",
  audience: "urn:asana:app",
  resource: "urn:asana:tasks",
  allowedScopes: ["tasks:read", "tasks:write"],
  authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "asana" },
});
const ASANA_AUTH_JSON = Object.freeze({
  flows: [
    {
      type: "oauth2-xaa",
      idJag: true,
      audience: ASANA_TARGET.audience,
      scopes: ASANA_TARGET.allowedScopes,
      operations: {
        "tasks.get": { scope: "tasks:read" },
        "tasks.create": { scope: "tasks:write" },
      },
    },
  ],
});

test("raw token defaults to the inferred scope and brokers XAA for ctx.user", async () => {
  const inference = inferAsanaUsage(`
    import { connector } from "@hobo/bindles";
    const asana = connector("asana");
    export async function sync(ctx) {
      await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });
    }
  `);
  const brokerRequests = [];
  const authorizationServer = createAuthorizationServer();
  const runtime = createRuntime({
    inference,
    authorizationServer,
    onPreMint: (request) => brokerRequests.push(request),
  });

  const result = await runtime.connector("asana").connection().token();

  assert.equal(result.ok, true);
  assert.deepEqual(result.requestedScopes, ["tasks:write"]);
  assert.deepEqual(result.credential.scopes, ["tasks:write"]);
  assert.deepEqual(result.manifestAllow, ["tasks:write"]);
  assert.equal(result.subject.delegatedBy.id, "user:priya");
  assert.equal(authorizationServer.calls.length, 1);
  assert.deepEqual(authorizationServer.calls[0].claims.scope, ["tasks:write"]);
  assert.equal(brokerRequests.length, 1);
  assert.deepEqual(brokerRequests[0].requestedScopes, ["tasks:write"]);
  assert.equal(brokerRequests[0].subject.delegatedBy.id, "user:priya");
  assert.equal(result.requestedScopes.includes("tasks:read"), false);
});

test("raw token rejects a broader explicit scope than the inferred manifest set", async () => {
  const inference = inferAsanaUsage(`
    import { connector } from "@hobo/bindles";
    const asana = connector("asana");
    export async function sync(ctx) {
      await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });
    }
  `);
  const broker = createCountingBroker();
  const runtime = createRuntime({ inference, broker });

  await assert.rejects(
    () => runtime.connector("asana").connection().token({ scopes: ["tasks:read", "tasks:write"] }),
    /cannot widen beyond inferred manifest allow/,
  );
  assert.equal(broker.calls.length, 0);
});

test("raw token may narrow to an explicit subset of the inferred scope set", async () => {
  const inference = inferAsanaUsage(`
    import { connector } from "@hobo/bindles";
    const asana = connector("asana");
    export async function sync(ctx) {
      await asana.tasks.get({ id: ctx.params.id, assignee: ctx.user.id });
      await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });
    }
  `);
  const authorizationServer = createAuthorizationServer();
  const runtime = createRuntime({ inference, authorizationServer });

  const result = await runtime.connector("asana").connection().token({ scopes: ["tasks:read"] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.manifestAllow, ["tasks:read", "tasks:write"]);
  assert.deepEqual(result.requestedScopes, ["tasks:read"]);
  assert.deepEqual(result.credential.scopes, ["tasks:read"]);
});

test("missing ctx.user refuses the broker before minting", async () => {
  const inference = inferAsanaUsage(`
    import { connector } from "@hobo/bindles";
    const asana = connector("asana");
    export async function sync(ctx) {
      await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });
    }
  `);
  const broker = createCountingBroker();
  const runtime = createRuntime({
    inference,
    broker,
    ctx: {
      identity: { kind: "agent", id: "agent:triage" },
    },
  });

  await assert.rejects(() => runtime.connector("asana").connection().token(), /ctx\.user is required/);
  assert.equal(broker.calls.length, 0);
});

test("manifest allow must match the actually observed connector operations", async () => {
  const inference = inferAsanaUsage(`
    import { connector } from "@hobo/bindles";
    const asana = connector("asana");
    export async function sync(ctx) {
      await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });
    }
  `);
  const manifest = structuredClone(inference.manifest);
  manifest.connectors.asana.allow = ["tasks:read", "tasks:write"];
  const broker = createCountingBroker();
  const runtime = createRuntime({ inference: { ...inference, manifest }, broker });

  await assert.rejects(
    () => runtime.connector("asana").connection().token(),
    /manifest allow must match observed connector scopes/,
  );
  assert.equal(broker.calls.length, 0);
});

function inferAsanaUsage(sourceText) {
  const result = inferConnectorScopes({
    sourceText,
    bindings: {
      asana: createConnectorBinding("asana", ASANA_AUTH_JSON),
    },
  });
  assert.equal(result.ok, true);
  return result;
}

function createRuntime({
  inference,
  broker,
  authorizationServer = createAuthorizationServer(),
  onPreMint = () => {},
  ctx = createCtx(),
}) {
  return createConnectorRuntime({
    ctx,
    manifest: inference.manifest,
    observedOperations: inference.observedOperations,
    targetCatalog: { asana: ASANA_TARGET },
    broker:
      broker ??
      createOutboundXaaTokenBroker({
        now: () => FIXED_NOW,
        preMintPolicy: async (request) => {
          onPreMint(request);
          return { ok: true };
        },
        targetAuthorizationServers: { asana: authorizationServer },
      }),
    requestIdFactory: (target) => `req-${target}`,
  });
}

function createCtx() {
  return {
    identity: { kind: "agent", id: "agent:triage" },
    user: {
      id: "user:priya",
      tokenRef: "identity://id-token/user-priya",
      tokenType: SUBJECT_TOKEN_TYPE,
    },
  };
}

function createAuthorizationServer() {
  const calls = [];
  return {
    calls,
    async redeemJwtBearer(request) {
      const parsed = parseJwtBearerGrantRequest(request, { now: FIXED_EPOCH });
      calls.push(parsed);
      return {
        tokenRef: "vault://tokens/asana/runtime",
        audience: ASANA_TARGET.audience,
        scopes: parsed.claims.scope,
        expiresAt: new Date(FIXED_NOW.getTime() + 5 * 60 * 1000).toISOString(),
      };
    },
  };
}

function createCountingBroker() {
  const calls = [];
  return {
    calls,
    async exchangeToken(request) {
      calls.push(request);
      return { ok: true, requestedScopes: request.requestedScopes };
    },
  };
}
