import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  AllowTripleEffectsError,
  compileAllowTripleEffects,
  compileBindleAllowTriples,
  createAllowScopedTokenBroker,
  assertGoldenTriple,
} from "../src/allow-triple-effects.js";

const goldenFixture = JSON.parse(
  readFileSync(new URL("../fixtures/hello-bindle-golden.json", import.meta.url), "utf8"),
);

test("one .allow() declaration compiles to IAM, link table, and token-scope ceiling", () => {
  const [declaration] = goldenFixture.declarations;
  const triple = compileAllowTripleEffects(
    {
      resourceId: declaration.resourceId,
      port: declaration.port,
      componentId: goldenFixture.componentId,
      verbs: declaration.verbs,
      bindle: goldenFixture.bindle,
    },
    { provider: "aws" },
  );

  assert.equal(triple.linkTable.denyByDefault, true);
  assert.deepEqual(triple.linkTable.allowedVerbs, ["get"]);
  assert.deepEqual(triple.tokenScopeCeiling.verbs, ["get"]);
  assert.ok(triple.iam.actions.every((action) => action.startsWith("dynamodb:")));
});

test("golden fixture asserts the IAM+link+scope triple for hello-bindle", () => {
  const triples = compileBindleAllowTriples({
    bindle: goldenFixture.bindle,
    componentId: goldenFixture.componentId,
    declarations: goldenFixture.declarations,
    provider: "aws",
  });

  assert.equal(triples.length, 1);
  assertGoldenTriple(triples[0], goldenFixture.triple);
});

test("deny-by-default link table rejects verbs outside .allow() ceiling", () => {
  const triple = compileAllowTripleEffects({
    resourceId: "todos",
    port: "wasi:keyvalue",
    componentId: "api",
    verbs: ["get"],
    bindle: "hello-bindle",
  });

  const denied = triple.linkTable.allowedVerbs.includes("set");
  assert.equal(denied, false);
  assert.equal(triple.linkTable.denyByDefault, true);
});

test("request_token within .allow() ceiling grants a scoped token with audit event", () => {
  const triple = compileAllowTripleEffects({
    resourceId: "todos",
    port: "wasi:keyvalue",
    componentId: "api",
    verbs: ["get"],
    bindle: "hello-bindle",
  });
  const broker = createAllowScopedTokenBroker([triple.tokenScopeCeiling]);

  const result = broker.requestToken({
    requestId: "req-allowed-1",
    subject: { kind: "agent", id: "agent:hello", delegatedBy: { kind: "user", id: "user:alice" } },
    request: {
      provider: "aws",
      scope: { port: "wasi:keyvalue", resource: "todos", action: "get" },
    },
    correlationId: "corr-hello-bindle",
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.auditEvent.type, "token.Granted");
  assert.deepEqual(result.scopes, ["aws:wasi:keyvalue:todos:get"]);
});

test("request_token exceeding .allow() ceiling is refused with auditable token.Denied event", () => {
  const triple = compileAllowTripleEffects({
    resourceId: "todos",
    port: "wasi:keyvalue",
    componentId: "api",
    verbs: ["get"],
    bindle: "hello-bindle",
  });
  const broker = createAllowScopedTokenBroker([triple.tokenScopeCeiling], {
    tenant: "tenant-a",
    actor: { kind: "service", id: "yard/identity/broker" },
  });

  const result = broker.requestToken({
    requestId: "req-denied-1",
    subject: { kind: "agent", id: "agent:hello", delegatedBy: { kind: "user", id: "user:alice" } },
    request: {
      provider: "aws",
      scope: { port: "wasi:keyvalue", resource: "todos", action: "set" },
    },
    correlationId: "corr-hello-bindle-deny",
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.auditEvent.type, "token.Denied");
  assert.match(result.reason, /exceeds \.allow\(\) ceiling/);
  assert.equal(
    broker.getAuditEvents().some((entry) => entry.type === "token.Granted"),
    false,
  );
});

test("blobstore .allow() emits s3 IAM actions and bucket resource pattern", () => {
  const triple = compileAllowTripleEffects(
    {
      resourceId: "assets",
      port: "wasi:blobstore",
      componentId: "api",
      verbs: ["read"],
      bindle: "hello-bindle",
    },
    { provider: "aws" },
  );

  assert.ok(triple.iam.actions.every((action) => action.startsWith("s3:")));
  assert.equal(triple.iam.resourcePattern, "arn:aws:s3:::hello-bindle-assets/*");
});

test("request_token for unknown resource is refused with auditable token.Denied event", () => {
  const triple = compileAllowTripleEffects({
    resourceId: "todos",
    port: "wasi:keyvalue",
    componentId: "api",
    verbs: ["get"],
    bindle: "hello-bindle",
  });
  const broker = createAllowScopedTokenBroker([triple.tokenScopeCeiling]);

  const result = broker.requestToken({
    requestId: "req-unknown-resource",
    subject: { kind: "agent", id: "agent:hello" },
    request: {
      provider: "aws",
      scope: { port: "wasi:keyvalue", resource: "secrets", action: "get" },
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.auditEvent.type, "token.Denied");
  assert.match(result.reason, /outside allow ceiling/);
});

test("request_token with mismatched port is refused with auditable token.Denied event", () => {
  const triple = compileAllowTripleEffects({
    resourceId: "todos",
    port: "wasi:keyvalue",
    componentId: "api",
    verbs: ["get"],
    bindle: "hello-bindle",
  });
  const broker = createAllowScopedTokenBroker([triple.tokenScopeCeiling]);

  const result = broker.requestToken({
    requestId: "req-wrong-port",
    subject: { kind: "agent", id: "agent:hello" },
    request: {
      provider: "aws",
      scope: { port: "wasi:blobstore", resource: "todos", action: "get" },
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.auditEvent.type, "token.Denied");
  assert.match(result.reason, /outside allow ceiling/);
});

test("adversarial: widening .allow() beyond declared verbs fails at compile time", () => {
  assert.throws(
    () =>
      compileAllowTripleEffects({
        resourceId: "todos",
        port: "wasi:keyvalue",
        componentId: "api",
        verbs: ["get", "admin"],
        bindle: "hello-bindle",
      }),
    (error) => {
      assert.ok(error instanceof AllowTripleEffectsError);
      assert.equal(error.code, "allow.verb-unknown");
      return true;
    },
  );
});
