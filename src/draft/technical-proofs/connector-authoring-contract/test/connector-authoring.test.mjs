import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildConnectorManifestEntry,
  createConnectorBinding,
  generateConnectorClientDeclaration,
} from "../src/connector-authoring.mjs";

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

test("connector generates a client from auth.json advertised operations", () => {
  const asana = createConnectorBinding("asana", asanaAuth);

  assert.equal(asana.client.tasks.get instanceof Function, true);
  assert.equal(asana.client.tasks.create instanceof Function, true);
  assert.equal(asana.client.tasks.delete, undefined);
  assert.throws(() => asana.call("tasks.delete"), /not advertised/);

  const declaration = generateConnectorClientDeclaration(asana);
  assert.match(declaration, /readonly tasks:/);
  assert.match(declaration, /get\(input: unknown\): ConnectorCall<"tasks:read">/);
  assert.match(declaration, /create\(input: unknown\): ConnectorCall<"tasks:write">/);
  assert.doesNotMatch(declaration, /delete\(/);
});

test("connector lowers usage-inferred XAA scope into the manifest entry", () => {
  const asana = createConnectorBinding("asana", asanaAuth);
  const entry = buildConnectorManifestEntry(asana, ["tasks.create"]);

  assert.deepEqual(entry, {
    type: "connector.v1",
    via: "xaa",
    audience: "urn:asana:app",
    onBehalfOf: "user",
    allow: ["tasks:write"],
    observedScopes: ["tasks:write"],
    declaredAllow: undefined,
    requestedScopeSource: "usage-inferred",
    usageContract: {
      compareObservedUsage: false,
      usageExceedsDeclaredAllow: false,
    },
    fallbackFrom: undefined,
  });
});

test("allow records a narrow-only declared set and keeps observed usage comparable", () => {
  const readOnlyAsana = createConnectorBinding("asana", asanaAuth).allow("tasks:read");
  const entry = buildConnectorManifestEntry(readOnlyAsana, ["tasks.get"]);

  assert.deepEqual(entry.allow, ["tasks:read"]);
  assert.deepEqual(entry.declaredAllow, ["tasks:read"]);
  assert.deepEqual(entry.observedScopes, ["tasks:read"]);
  assert.equal(entry.requestedScopeSource, "declared-narrowing");
  assert.deepEqual(entry.usageContract, {
    compareObservedUsage: true,
    usageExceedsDeclaredAllow: false,
  });
});

test("allow narrower than observed usage is marked for can-deploy comparison", () => {
  const readOnlyAsana = createConnectorBinding("asana", asanaAuth).allow("tasks:read");
  const entry = buildConnectorManifestEntry(readOnlyAsana, ["tasks.create"]);

  assert.deepEqual(entry.allow, ["tasks:read"]);
  assert.deepEqual(entry.observedScopes, ["tasks:write"]);
  assert.deepEqual(entry.usageContract, {
    compareObservedUsage: true,
    usageExceedsDeclaredAllow: true,
  });
});

test("non-XAA targets record the fallback flow instead of dropping the dependency", () => {
  const fallbackAuth = {
    issuer: "https://legacy.example.com",
    flows: [
      {
        type: "oauth2-obo",
        authorizationServer: "https://legacy.example.com/oauth",
        audience: "urn:legacy:app",
        scopes: ["tickets:read"],
        operations: {
          "tickets.list": { scope: "tickets:read" },
        },
      },
    ],
  };

  const legacy = createConnectorBinding("legacy", fallbackAuth);
  const entry = buildConnectorManifestEntry(legacy, ["tickets.list"]);

  assert.equal(entry.via, "oauth2-obo");
  assert.equal(entry.fallbackFrom, "oauth2-xaa");
  assert.deepEqual(entry.allow, ["tickets:read"]);
});

test("static-secret flows are not accepted as XAA authoring fallbacks", () => {
  assert.throws(
    () =>
      createConnectorBinding("legacy", {
        flows: [
          {
            type: "api-key",
            scopes: ["tickets:read"],
            operations: {
              "tickets.list": { scope: "tickets:read" },
            },
          },
        ],
      }),
    /supported external-dependency auth flow/
  );
});

test("scope strings from auth.json are validated against advertised scopes", () => {
  assert.throws(
    () =>
      createConnectorBinding("asana", {
        ...asanaAuth,
        flows: [
          {
            ...asanaAuth.flows[0],
            operations: {
              "tasks.create": { scope: "tasks:admin" },
            },
          },
        ],
      }),
    /scope not advertised/
  );

  assert.throws(
    () => createConnectorBinding("asana", asanaAuth).allow("tasks:admin"),
    /scope not advertised/
  );

  assert.throws(
    () =>
      createConnectorBinding("asana", {
        ...asanaAuth,
        flows: [{ ...asanaAuth.flows[0], scopes: ["tasks:*"] }],
      }),
    /Invalid scope/
  );

  assert.throws(
    () =>
      createConnectorBinding("asana", {
        ...asanaAuth,
        flows: [{ ...asanaAuth.flows[0], idJag: false }],
      }),
    /idJag: true/
  );
});
