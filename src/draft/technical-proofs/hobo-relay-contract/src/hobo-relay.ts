import { evaluateMtlsHandshake } from "../../mtls-data-path-contract/src/mtls-data-path.js";

const REGISTER_ACTION = "hobo:relay:register";
const ATTACH_ACTION = "hobo:relay:attach";
const METADATA_ENDPOINT_ADDRESSES = new Set([
  "169.254.169.254",
  "fd00:ec2::254",
  "metadata.google.internal"
]);
const FORBIDDEN_WORK_CREDENTIAL_FIELDS = [
  "credential",
  "credentials",
  "credentialMaterial",
  "providerToken",
  "token",
  "secret"
];

export function registerRelay(spec, policyDecision) {
  const policy = evaluateRelayPolicy(spec, REGISTER_ACTION, policyDecision);
  if (!policy.ok) return policy;

  if (
    spec?.transport?.direction !== "relay-to-yard" ||
    spec?.transport?.protocol !== "tcp" ||
    spec?.transport?.port !== 443
  ) {
    return invalid("relay.transport.not-outbound", "relay must dial the Yard over outbound TCP 443");
  }

  if (Array.isArray(spec.inboundListeners) && spec.inboundListeners.length > 0) {
    return invalid("relay.inbound.exposed", "relay contract forbids inbound listeners into the private network");
  }

  const relay = clone({
    ...spec,
    inboundListeners: [],
    targetIds: spec.targets.map((target) => target.targetId)
  });

  return {
    ok: true,
    relay,
    audit: [
      ...policy.audit,
      {
        type: "relay.Registered",
        relayId: spec.relayId,
        targetIds: relay.targetIds
      }
    ]
  };
}

export function attachRelay(relay, policyDecision) {
  const policy = evaluateRelayPolicy(relay, ATTACH_ACTION, policyDecision);
  if (!policy.ok) return policy;

  const handshake = evaluateMtlsHandshake(relay.mtls);
  if (!handshake.ok) {
    return invalid("relay.attach.svid-rejected", handshake.reason);
  }

  return {
    ok: true,
    session: {
      relayId: relay.relayId,
      tenant: relay.tenant,
      transport: clone(relay.transport),
      hasInboundListener: false,
      targetIds: relay.targetIds.slice(),
      targets: relay.targets.map(clone),
      peer: {
        spiffeId: relay.mtls.peerCertificate.spiffeId,
        parsed: handshake.peer
      }
    },
    audit: [
      ...policy.audit,
      {
        type: "relay.Attached",
        relayId: relay.relayId,
        peerSvid: relay.mtls.peerCertificate.spiffeId
      }
    ]
  };
}

export function routeRelayTarget(session, targetId) {
  const target = session.targets.find((candidate) => candidate.targetId === targetId);
  if (!target) {
    return invalid(
      "relay.target.unknown",
      `target id ${targetId} is not registered for relay ${session.relayId}`
    );
  }

  return {
    ok: true,
    relayId: session.relayId,
    target: clone(target)
  };
}

export function authorizeRelayConnection(session, request) {
  if (!request?.targetId) {
    return denyRelayRequest(
      session,
      null,
      "relay.forward-proxy.denied",
      "relay requires a registered target id for every private-network connection"
    );
  }

  const route = routeRelayTarget(session, request.targetId);
  if (!route.ok) {
    return denyRelayRequest(session, request.targetId, route.code, route.reason);
  }

  const target = route.target;
  if (!target.endpoint) {
    return denyRelayRequest(
      session,
      request.targetId,
      "relay.target.endpoint-missing",
      `target ${request.targetId} has no registered endpoint`
    );
  }

  const destination = request.destination ?? {};
  if (destination.host !== target.endpoint.host || destination.port !== target.endpoint.port) {
    return denyRelayRequest(
      session,
      request.targetId,
      "relay.target.address-mismatch",
      `target ${request.targetId} may only connect to ${formatEndpoint(target.endpoint)}`
    );
  }

  if (isMetadataEndpoint(destination)) {
    return denyRelayRequest(
      session,
      request.targetId,
      "relay.target.metadata-endpoint-denied",
      `target ${request.targetId} resolves to a metadata endpoint`
    );
  }

  const allowedIps = target.endpoint.allowedResolvedIps ?? [];
  if (allowedIps.length === 0) {
    return denyRelayRequest(
      session,
      request.targetId,
      "relay.target.rebinding-denied",
      `target ${request.targetId} has no explicit resolved IP allowlist`
    );
  }

  if (!allowedIps.includes(destination.resolvedIp)) {
    return denyRelayRequest(
      session,
      request.targetId,
      "relay.target.rebinding-denied",
      `target ${request.targetId} resolved to unregistered address ${destination.resolvedIp}`
    );
  }

  return {
    ok: true,
    connection: {
      connectionId: request.connectionId,
      relayId: session.relayId,
      targetId: request.targetId,
      destination: clone(destination)
    },
    audit: [{
      type: "relay.ConnectionAuthorized",
      relayId: session.relayId,
      targetId: request.targetId
    }]
  };
}

export function pipelineRelayConnect(connection, request) {
  return {
    ok: false,
    code: "relay.connection.pipelining-denied",
    reason: `connection ${connection.connectionId} is scoped to target ${connection.targetId} and cannot open a second target`,
    audit: [{
      type: "relay.RequestDenied",
      relayId: connection.relayId,
      targetId: connection.targetId,
      attemptedTargetId: request?.targetId,
      reason: "relay.connection.pipelining-denied"
    }]
  };
}

export function attemptInboundConnection(session) {
  return invalid("relay.inbound.unavailable", `relay ${session.relayId} exposes no inbound listener`);
}

export function dispatchRelayWork(session, work) {
  for (const field of FORBIDDEN_WORK_CREDENTIAL_FIELDS) {
    if (field in work) {
      return invalid(
        "relay.credential.egress",
        "Yard work frames must carry private-network credential references, never credential material"
      );
    }
  }

  const route = routeRelayTarget(session, work.targetId);
  if (!route.ok) return route;

  if (!Array.isArray(route.target.allowedResourceIds) || route.target.allowedResourceIds.length === 0) {
    return {
      ok: false,
      code: "relay.work.scope-missing",
      reason: `target ${work.targetId} has no registered resource scope`,
      audit: [{
        type: "relay.RequestDenied",
        relayId: session.relayId,
        targetId: work.targetId,
        workId: work.workId,
        reason: "relay.work.scope-missing"
      }]
    };
  }

  if (!route.target.allowedResourceIds.includes(work.resourceId)) {
    return {
      ok: false,
      code: "relay.work.out-of-scope",
      reason: `work ${work.workId} targets resource ${work.resourceId} outside target ${work.targetId} scope`,
      audit: [{
        type: "relay.RequestDenied",
        relayId: session.relayId,
        targetId: work.targetId,
        workId: work.workId,
        reason: "relay.work.out-of-scope"
      }]
    };
  }

  return {
    ok: true,
    yardFrames: [
      {
        type: "relay.WorkDispatched",
        relayId: session.relayId,
        targetId: work.targetId,
        workId: work.workId,
        resourceId: work.resourceId,
        provider: work.provider
      },
      {
        type: "exec.Succeeded",
        relayId: session.relayId,
        targetId: work.targetId,
        workId: work.workId,
        outputs: clone(work.outputs)
      }
    ],
    privateExecutorFrame: {
      targetId: work.targetId,
      workId: work.workId,
      resourceId: work.resourceId,
      provider: work.provider,
      credentialRef: work.credentialRef
    }
  };
}

function evaluateRelayPolicy(spec, action, decision = {}) {
  const relayId = spec?.relayId ?? "unknown";
  const effect = decision.action === action ? decision.effect : "deny";
  const audit = [
    {
      type: "policy.Decided",
      action,
      effect,
      relayId
    }
  ];

  if (effect !== "allow") {
    return {
      ok: false,
      code: "relay.policy.denied",
      reason: `policy denied ${action} for relay ${relayId}`,
      audit
    };
  }

  return { ok: true, audit };
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function denyRelayRequest(session, targetId, code, reason) {
  return {
    ok: false,
    code,
    reason,
    audit: [{
      type: "relay.RequestDenied",
      relayId: session.relayId,
      targetId,
      reason: code
    }]
  };
}

function formatEndpoint(endpoint) {
  return `${endpoint.host}:${endpoint.port}`;
}

function isMetadataEndpoint(destination) {
  const host = String(destination.host ?? "").toLowerCase();
  const resolvedIp = String(destination.resolvedIp ?? "").toLowerCase();
  return METADATA_ENDPOINT_ADDRESSES.has(host) || METADATA_ENDPOINT_ADDRESSES.has(resolvedIp);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
