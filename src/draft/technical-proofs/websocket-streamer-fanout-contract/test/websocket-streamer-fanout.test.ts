import assert from "node:assert/strict";
import { test } from "vitest";

import { createRuntimeLocalStreamer } from "../../streamer-runtime-port-contract/src/streamer-runtime-port.js";
import {
  WebsocketCapabilityDeniedError,
  createStoppedYardProbe,
  createWebsocketStreamerFanout,
  runWebsocketStreamerFanoutConformance,
} from "../src/websocket-streamer-fanout.js";

test("broadcast fans out through Streamer while the Yard is stopped", async () => {
  const yard = createStoppedYardProbe();
  const runtime = createWebsocketStreamerFanout({
    streamer: createRuntimeLocalStreamer(),
    yard,
  });

  const alice = runtime.connect({
    connectionId: "conn-alice",
    principal: principal("alice", "tenant-a"),
    allow: ["accept", "broadcast", "subscribe"],
  });
  const bob = runtime.connect({
    connectionId: "conn-bob",
    principal: principal("bob", "tenant-a"),
    allow: ["accept", "subscribe"],
  });

  runtime.join("conn-alice", "tenant:tenant-a:room:general");
  runtime.join("conn-bob", "tenant:tenant-a:room:general");

  await runtime.broadcast("conn-alice", "tenant:tenant-a:room:general", {
    text: "ship",
  });

  assert.deepEqual(await readNextChunk(bob.readable), {
    type: "websocket.message",
    channel: "tenant:tenant-a:room:general",
    from: "conn-alice",
    principal: principal("alice", "tenant-a"),
    message: { text: "ship" },
  });
  assert.deepEqual(yard.calls, []);
  assert.equal(alice.connectionId, "conn-alice");
});

test("principal returns the verified connection principal", () => {
  const runtime = createWebsocketStreamerFanout({
    streamer: createRuntimeLocalStreamer(),
    yard: createStoppedYardProbe(),
  });

  runtime.connect({
    connectionId: "conn-alice",
    principal: principal("alice", "tenant-a"),
    allow: ["accept"],
  });

  assert.deepEqual(runtime.principal("conn-alice"), principal("alice", "tenant-a"));
});

test("outbound connect mode requires the connect verb", () => {
  const runtime = createWebsocketStreamerFanout({
    streamer: createRuntimeLocalStreamer(),
    yard: createStoppedYardProbe(),
  });

  runtime.connect({
    connectionId: "conn-outbound",
    principal: principal("outbound", "tenant-a"),
    allow: ["connect"],
    mode: "connect",
  });

  assert.deepEqual(runtime.principal("conn-outbound"), principal("outbound", "tenant-a"));
  assert.throws(
    () =>
      runtime.connect({
        connectionId: "conn-outbound-denied",
        principal: principal("denied-outbound", "tenant-a"),
        allow: ["accept"],
        mode: "connect",
      }),
    (error) =>
      error instanceof WebsocketCapabilityDeniedError &&
      error.code === "websocket.verb-not-granted" &&
      error.verb === "connect",
  );
});

test("send-to writes a direct frame through Streamer while Yard is stopped", async () => {
  const yard = createStoppedYardProbe();
  const runtime = createWebsocketStreamerFanout({
    streamer: createRuntimeLocalStreamer(),
    yard,
  });

  runtime.connect({
    connectionId: "conn-alice",
    principal: principal("alice", "tenant-a"),
    allow: ["accept", "send"],
  });
  const bob = runtime.connect({
    connectionId: "conn-bob",
    principal: principal("bob", "tenant-a"),
    allow: ["accept"],
  });

  await runtime.sendTo("conn-alice", "conn-bob", {
    text: "direct",
  });

  assert.deepEqual(await readNextChunk(bob.readable), {
    type: "websocket.message",
    channel: "direct:conn-bob",
    from: "conn-alice",
    principal: principal("alice", "tenant-a"),
    message: { text: "direct" },
  });
  assert.deepEqual(yard.calls, []);
});

test("leave removes channel membership before future broadcasts", async () => {
  const runtime = createWebsocketStreamerFanout({
    streamer: createRuntimeLocalStreamer(),
    yard: createStoppedYardProbe(),
  });

  runtime.connect({
    connectionId: "conn-alice",
    principal: principal("alice", "tenant-a"),
    allow: ["accept", "broadcast", "subscribe"],
  });
  runtime.join("conn-alice", "tenant:tenant-a:room:general");
  runtime.leave("conn-alice", "tenant:tenant-a:room:general");

  await assert.rejects(
    () =>
      runtime.broadcast("conn-alice", "tenant:tenant-a:room:general", {
        text: "after leave",
      }),
    (error) =>
      error instanceof WebsocketCapabilityDeniedError &&
      error.code === "websocket.channel-not-joined",
  );
});

test("unallowed broadcast verb is denied by default", async () => {
  const runtime = createWebsocketStreamerFanout({
    streamer: createRuntimeLocalStreamer(),
    yard: createStoppedYardProbe(),
  });

  runtime.connect({
    connectionId: "conn-alice",
    principal: principal("alice", "tenant-a"),
    allow: ["accept", "subscribe"],
  });
  runtime.join("conn-alice", "tenant:tenant-a:room:general");

  await assert.rejects(
    () =>
      runtime.broadcast("conn-alice", "tenant:tenant-a:room:general", {
        text: "not allowed",
      }),
    (error) =>
      error instanceof WebsocketCapabilityDeniedError &&
      error.code === "websocket.verb-not-granted" &&
      error.verb === "broadcast",
  );
});

test("cross-tenant channel access fails closed before fan-out", () => {
  const runtime = createWebsocketStreamerFanout({
    streamer: createRuntimeLocalStreamer(),
    yard: createStoppedYardProbe(),
  });

  runtime.connect({
    connectionId: "conn-alice",
    principal: principal("alice", "tenant-a"),
    allow: ["accept", "broadcast", "subscribe"],
  });

  assert.throws(
    () => runtime.join("conn-alice", "tenant:tenant-b:room:private"),
    (error) =>
      error instanceof WebsocketCapabilityDeniedError &&
      error.code === "websocket.channel-not-authorized" &&
      error.connectionId === "conn-alice",
  );
});

test("conformance report proves Streamer path, zero Yard calls, and deny-by-default", async () => {
  const report = await runWebsocketStreamerFanoutConformance((options = {}) =>
    createWebsocketStreamerFanout({
      streamer: createRuntimeLocalStreamer(),
      yard: options.yard ?? createStoppedYardProbe(),
    }),
  );

  assert.deepEqual(report, {
    contract: "hobo.websocket-streamer-fanout/v1",
    assertions: {
      streamerFanoutWhenYardStopped: "pass",
      zeroYardCallsOnDataPath: "pass",
      principalBoundConnections: "pass",
      outboundConnectVerb: "pass",
      denyByDefaultVerbs: "pass",
      crossTenantChannelsFailClosed: "pass",
    },
  });
});

async function readNextChunk(readable) {
  const iterator = readable[Symbol.asyncIterator]();
  const next = await iterator.next();
  assert.equal(next.done, false);
  return next.value.chunk;
}

function principal(id, tenant) {
  return {
    kind: "user",
    id,
    tenant,
  };
}
