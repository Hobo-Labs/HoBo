import assert from "node:assert/strict";
import { isJsonString, isJsonObject } from "./json.js";


export const WEBSOCKET_STREAMER_FANOUT_CONTRACT_VERSION = "hobo.websocket-streamer-fanout/v1";

const WEBSOCKET_STREAM = "websocket";
const REQUIRED_VERBS = Object.freeze(["accept", "connect", "send", "broadcast", "subscribe"]);

export class WebsocketCapabilityDeniedError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${details.connectionId ?? "unknown"}`);
    this.name = "WebsocketCapabilityDeniedError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function createStoppedYardProbe() {
  return {
    stopped: true,
    calls: [],
    call(path) {
      this.calls.push(path);
      throw new Error(`Yard is stopped; data path attempted ${path}`);
    },
  };
}

export function createWebsocketStreamerFanout({ streamer, yard }) {
  return new WebsocketStreamerFanout({ streamer, yard });
}

export async function runWebsocketStreamerFanoutConformance(createRuntime) {
  await provesStreamerFanoutWhenYardStopped(createRuntime);
  await provesPrincipalBoundConnections(createRuntime);
  await provesOutboundConnectVerb(createRuntime);
  await provesDenyByDefaultVerbs(createRuntime);
  await provesCrossTenantChannelsFailClosed(createRuntime);

  const yard = createStoppedYardProbe();
  const runtime = createRuntimeWithYard(createRuntime, yard);
  const sender = runtime.connect({
    connectionId: "conn-zero-yard-sender",
    principal: principal("sender", "tenant-a"),
    allow: ["accept", "broadcast", "subscribe"],
  });
  runtime.connect({
    connectionId: "conn-zero-yard-recipient",
    principal: principal("recipient", "tenant-a"),
    allow: ["accept", "subscribe"],
  });
  runtime.join(sender.connectionId, "tenant:tenant-a:room:zero-yard");
  runtime.join("conn-zero-yard-recipient", "tenant:tenant-a:room:zero-yard");
  await runtime.broadcast(sender.connectionId, "tenant:tenant-a:room:zero-yard", {
    ok: true,
  });
  assert.deepEqual(runtime.yardCalls(), []);

  return {
    contract: WEBSOCKET_STREAMER_FANOUT_CONTRACT_VERSION,
    assertions: {
      streamerFanoutWhenYardStopped: "pass",
      zeroYardCallsOnDataPath: "pass",
      principalBoundConnections: "pass",
      outboundConnectVerb: "pass",
      denyByDefaultVerbs: "pass",
      crossTenantChannelsFailClosed: "pass",
    },
  };
}

class WebsocketStreamerFanout {
  #streamer;
  #yard;
  #connections = new Map();
  #channels = new Map();

  constructor({ streamer, yard }) {
    if (!streamer || !(streamer.createRun instanceof Function)) {
      throw new TypeError("streamer must expose createRun");
    }
    this.#streamer = streamer;
    this.#yard = yard ?? createStoppedYardProbe();
  }

  connect({ connectionId, principal: connectionPrincipal, allow = [], mode = "accept" }) {
    const normalizedConnectionId = assertNonEmptyString(connectionId, "connectionId");
    if (this.#connections.has(normalizedConnectionId)) {
      throw new Error(`websocket connection already exists: ${normalizedConnectionId}`);
    }

    const grant = normalizeAllow(allow);
    const gateVerb = normalizeConnectionMode(mode);
    requireVerb({
      connectionId: normalizedConnectionId,
      grant,
      verb: gateVerb,
    });

    const normalizedPrincipal = normalizePrincipal(connectionPrincipal);
    const run = this.#streamer.createRun({
      runId: `ws:${normalizedConnectionId}`,
    });
    const connection = {
      connectionId: normalizedConnectionId,
      principal: normalizedPrincipal,
      allow: grant,
      channels: new Set(),
      run,
      writable: run.getWritable(WEBSOCKET_STREAM),
    };
    this.#connections.set(normalizedConnectionId, connection);

    return Object.freeze({
      connectionId: normalizedConnectionId,
      readable: run.readable,
      principal: structuredClone(normalizedPrincipal),
    });
  }

  principal(connectionId) {
    return structuredClone(this.#requireConnection(connectionId).principal);
  }

  join(connectionId, channel) {
    const connection = this.#requireConnection(connectionId);
    const normalizedChannel = assertNonEmptyString(channel, "channel");
    requireVerb({
      connectionId: connection.connectionId,
      grant: connection.allow,
      verb: "subscribe",
    });
    requireChannelAccess(connection, normalizedChannel);

    connection.channels.add(normalizedChannel);
    const members = this.#channels.get(normalizedChannel) ?? new Set();
    members.add(connection.connectionId);
    this.#channels.set(normalizedChannel, members);

    return {
      connectionId: connection.connectionId,
      channel: normalizedChannel,
      transport: "streamer",
    };
  }

  leave(connectionId, channel) {
    const connection = this.#requireConnection(connectionId);
    const normalizedChannel = assertNonEmptyString(channel, "channel");
    requireVerb({
      connectionId: connection.connectionId,
      grant: connection.allow,
      verb: "subscribe",
    });

    connection.channels.delete(normalizedChannel);
    this.#channels.get(normalizedChannel)?.delete(connection.connectionId);
  }

  async sendTo(fromConnectionId, toConnectionId, message) {
    const sender = this.#requireConnection(fromConnectionId);
    const recipient = this.#requireConnection(toConnectionId);
    requireVerb({
      connectionId: sender.connectionId,
      grant: sender.allow,
      verb: "send",
    });
    requireSharedTenant(sender, recipient);

    await recipient.writable.write({
      type: "websocket.message",
      channel: `direct:${recipient.connectionId}`,
      from: sender.connectionId,
      principal: structuredClone(sender.principal),
      message: structuredClone(message),
    });
  }

  async broadcast(connectionId, channel, message) {
    const sender = this.#requireConnection(connectionId);
    const normalizedChannel = assertNonEmptyString(channel, "channel");
    requireVerb({
      connectionId: sender.connectionId,
      grant: sender.allow,
      verb: "broadcast",
    });
    requireChannelAccess(sender, normalizedChannel);
    requireChannelMembership(sender, normalizedChannel);

    const members = this.#channels.get(normalizedChannel) ?? new Set();
    for (const memberId of members) {
      const member = this.#requireConnection(memberId);
      requireChannelAccess(member, normalizedChannel);
      await member.writable.write({
        type: "websocket.message",
        channel: normalizedChannel,
        from: sender.connectionId,
        principal: structuredClone(sender.principal),
        message: structuredClone(message),
      });
    }
  }

  yardCalls() {
    return [...(this.#yard.calls ?? [])];
  }

  supportedVerbs() {
    return [...REQUIRED_VERBS];
  }

  #requireConnection(connectionId) {
    const normalizedConnectionId = assertNonEmptyString(connectionId, "connectionId");
    const connection = this.#connections.get(normalizedConnectionId);
    if (!connection) {
      throw new WebsocketCapabilityDeniedError("websocket.connection-not-found", {
        connectionId: normalizedConnectionId,
      });
    }
    return connection;
  }
}

function createRuntimeWithYard(createRuntime, yard) {
  const runtime = createRuntime({ yard });
  return runtime;
}

async function provesStreamerFanoutWhenYardStopped(createRuntime) {
  const runtime = createRuntime();
  const recipient = runtime.connect({
    connectionId: "conn-bob",
    principal: principal("bob", "tenant-a"),
    allow: ["accept", "subscribe"],
  });
  runtime.connect({
    connectionId: "conn-alice",
    principal: principal("alice", "tenant-a"),
    allow: ["accept", "broadcast", "subscribe"],
  });
  runtime.join("conn-alice", "tenant:tenant-a:room:general");
  runtime.join("conn-bob", "tenant:tenant-a:room:general");

  await runtime.broadcast("conn-alice", "tenant:tenant-a:room:general", {
    text: "hello",
  });

  assert.equal((await readNext(recipient.readable)).chunk.message.text, "hello");
}

function provesPrincipalBoundConnections(createRuntime) {
  const runtime = createRuntime();
  runtime.connect({
    connectionId: "conn-principal",
    principal: principal("casey", "tenant-a"),
    allow: ["accept"],
  });

  assert.deepEqual(runtime.principal("conn-principal"), principal("casey", "tenant-a"));
}

function provesOutboundConnectVerb(createRuntime) {
  const runtime = createRuntime();
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
}

async function provesDenyByDefaultVerbs(createRuntime) {
  const runtime = createRuntime();
  runtime.connect({
    connectionId: "conn-deny",
    principal: principal("denied", "tenant-a"),
    allow: ["accept", "subscribe"],
  });
  runtime.join("conn-deny", "tenant:tenant-a:room:general");

  await assert.rejects(
    () => runtime.broadcast("conn-deny", "tenant:tenant-a:room:general", {}),
    (error) =>
      error instanceof WebsocketCapabilityDeniedError &&
      error.code === "websocket.verb-not-granted",
  );
}

function provesCrossTenantChannelsFailClosed(createRuntime) {
  const runtime = createRuntime();
  runtime.connect({
    connectionId: "conn-cross-tenant",
    principal: principal("alice", "tenant-a"),
    allow: ["accept", "broadcast", "subscribe"],
  });

  assert.throws(
    () => runtime.join("conn-cross-tenant", "tenant:tenant-b:room:general"),
    (error) =>
      error instanceof WebsocketCapabilityDeniedError &&
      error.code === "websocket.channel-not-authorized",
  );
}

async function readNext(readable) {
  const iterator = readable[Symbol.asyncIterator]();
  const next = await iterator.next();
  assert.equal(next.done, false);
  return next.value;
}

function requireVerb({ connectionId, grant, verb }) {
  if (!grant.has(verb)) {
    throw new WebsocketCapabilityDeniedError("websocket.verb-not-granted", {
      connectionId,
      verb,
    });
  }
}

function requireChannelAccess(connection, channel) {
  const tenant = channel.match(/^tenant:([^:]+):/)?.[1];
  if (!tenant || tenant !== connection.principal.tenant) {
    throw new WebsocketCapabilityDeniedError("websocket.channel-not-authorized", {
      connectionId: connection.connectionId,
      channel,
      principalTenant: connection.principal.tenant,
    });
  }
}

function requireChannelMembership(connection, channel) {
  if (!connection.channels.has(channel)) {
    throw new WebsocketCapabilityDeniedError("websocket.channel-not-joined", {
      connectionId: connection.connectionId,
      channel,
    });
  }
}

function requireSharedTenant(sender, recipient) {
  if (sender.principal.tenant !== recipient.principal.tenant) {
    throw new WebsocketCapabilityDeniedError("websocket.peer-not-authorized", {
      connectionId: sender.connectionId,
      peerConnectionId: recipient.connectionId,
    });
  }
}

function normalizeAllow(allow) {
  if (!Array.isArray(allow)) {
    throw new TypeError("allow must be an array of websocket verbs");
  }

  const grant = new Set();
  for (const verb of allow) {
    const normalizedVerb = assertNonEmptyString(verb, "allow verb");
    if (!REQUIRED_VERBS.includes(normalizedVerb)) {
      throw new WebsocketCapabilityDeniedError("websocket.verb-unknown", {
        verb: normalizedVerb,
      });
    }
    grant.add(normalizedVerb);
  }
  return grant;
}

function normalizeConnectionMode(mode) {
  const normalizedMode = assertNonEmptyString(mode, "mode");
  if (normalizedMode !== "accept" && normalizedMode !== "connect") {
    throw new TypeError("mode must be accept or connect");
  }
  return normalizedMode;
}

function normalizePrincipal(value) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError("principal must be an object");
  }
  const kind = assertNonEmptyString(value.kind, "principal.kind");
  const id = assertNonEmptyString(value.id, "principal.id");
  const tenant = assertNonEmptyString(value.tenant, "principal.tenant");

  return Object.freeze({ kind, id, tenant });
}

function assertNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function principal(id, tenant) {
  return {
    kind: "user",
    id,
    tenant,
  };
}
