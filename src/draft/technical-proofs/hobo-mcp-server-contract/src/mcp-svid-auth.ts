import { createHoboMcpServer, MCP_TOOL_SPECS } from "./mcp-server-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export function createSvidBoundHoboMcpServer(options = {}) {
  const specs = options.tools ?? MCP_TOOL_SPECS;
  const specByName = new Map(specs.map((spec) => [spec.name, spec]));
  const now = options.now ?? (() => new Date());
  const verifySvid = options.verifySvid ?? options.svidVerifier;
  const auditSink = options.auditSink ?? (() => {});
  const tokenBroker = options.tokenBroker ?? null;
  const issuedTokenRefs = new Set();

  return Object.freeze({
    listTools() {
      return specs.map(publicTool);
    },

    listTransports() {
      return [
        { kind: "stdio", framing: "json-rpc-2.0" },
        { kind: "http", framing: "json-rpc-2.0", path: "/mcp" },
      ];
    },

    async callTool(name, input = {}, callOptions = {}) {
      const spec = specByName.get(name);
      if (!spec) {
        return failure(name, "MCP_TOOL_UNKNOWN", `Unknown MCP tool "${name}".`);
      }

      const auth = await authenticateSvid({
        assertion: options.svidAssertion,
        verifySvid,
        now,
        tool: name,
        toolCallId: callOptions.toolCallId,
      });
      if (!auth.ok) {
        return failure(name, auth.code, auth.message);
      }

      const validation = validateInput(spec.inputSchema, input);
      if (!validation.ok) {
        return failure(name, "MCP_INPUT_INVALID", validation.message);
      }

      const requiredCapability = toolCapabilityFor(name);
      if (!scopeAllows(auth.scopes, requestedAction(requiredCapability))) {
        emitAudit(auditSink, {
          type: "policy.Decided",
          time: toIso(now),
          data: {
            decision: "deny",
            reason: "missing MCP tool capability",
            subject: auth.principal,
            svidId: auth.svid.id,
            tool: name,
            toolCallId: callOptions.toolCallId,
            requiredCapability,
          },
        });
        return failure(name, "MCP_SCOPE_DENIED", `${name} requires MCP tool capability ${requiredCapability.resource}:call.`);
      }

      if (name === "request_token") {
        return callScopedRequestToken({
          input,
          tokenBroker,
          auth,
          now,
          auditSink,
          toolCallId: callOptions.toolCallId,
          issuedTokenRefs,
        });
      }

      const server = createHoboMcpServer({
        ...options,
        tools: specs,
        identity: auth.principal,
        tokenBroker: undefined,
      });
      return server.callTool(name, input, callOptions);
    },

    revokeToken(tokenRef, options = {}) {
      if (!issuedTokenRefs.has(tokenRef)) {
        return failure("request_token", "MCP_TOKEN_UNKNOWN", "Token grant is not tracked by this MCP session.");
      }
      issuedTokenRefs.delete(tokenRef);
      const event = {
        type: "token.Revoked",
        time: toIso(now),
        data: {
          tokenRef,
          reason: options.reason ?? "session revoked",
          tool: "request_token",
          toolCallId: options.toolCallId,
        },
      };
      emitAudit(auditSink, event);
      return success("request_token", { tokenRef, event });
    },
  });
}

export function toolCapabilityFor(toolName) {
  return {
    port: "hobo:mcp",
    resource: `tool:${toolName}`,
    actions: ["call"],
  };
}

async function authenticateSvid({ assertion, verifySvid, now, tool, toolCallId }) {
  if (!assertion) {
    return {
      ok: false,
      code: "MCP_AUTH_REQUIRED",
      message: `${tool} requires a verified SVID-bound MCP session.`,
    };
  }
  if (!(verifySvid instanceof Function)) {
    return {
      ok: false,
      code: "MCP_AUTH_REQUIRED",
      message: `${tool} requires a SVID verifier.`,
    };
  }

  const result = await verifySvid(assertion, { tool, toolCallId, time: toIso(now) });
  if (!result?.ok) {
    return svidFailure(result, tool);
  }

  const principal = result.principal ?? result.subject;
  if (!isPlainObject(principal)) {
    return {
      ok: false,
      code: "MCP_AUTH_INVALID",
      message: "SVID verifier must return a principal.",
    };
  }

  const svid = normalizeSvid(result.svid);
  if (svid.expiresAt && new Date(svid.expiresAt).getTime() <= currentTime(now).getTime()) {
    return {
      ok: false,
      code: "MCP_AUTH_EXPIRED",
      message: "SVID has expired; re-authentication is required.",
    };
  }

  return {
    ok: true,
    principal: clone(principal),
    svid,
    scopes: normalizeSvidScopeSet(result.scopes ?? result.svidScope ?? []),
  };
}

function svidFailure(result, tool) {
  const code = result?.code ?? "SVID_INVALID";
  const message = result?.message ?? `${tool} requires a valid SVID assertion.`;
  const mapped = {
    SVID_EXPIRED: "MCP_AUTH_EXPIRED",
    SVID_REVOKED: "MCP_AUTH_REVOKED",
    SVID_REPLAYED: "MCP_AUTH_REPLAYED",
  }[code] ?? "MCP_AUTH_INVALID";

  return {
    ok: false,
    code: mapped,
    message,
  };
}

function normalizeSvid(value) {
  const svid = isPlainObject(value) ? value : {};
  return {
    id: isJsonString(svid.id) && svid.id.length > 0 ? svid.id : "svid:unknown",
    issuer: isJsonString(svid.issuer) ? svid.issuer : undefined,
    expiresAt: isJsonString(svid.expiresAt) ? svid.expiresAt : undefined,
  };
}

function normalizeSvidScopeSet(scopes) {
  if (!Array.isArray(scopes)) {
    return [];
  }
  return scopes
    .filter(isPlainObject)
    .map((scope) => ({
      port: isJsonString(scope.port) ? scope.port : "",
      resource: isJsonString(scope.resource) ? scope.resource : "",
      actions: Array.isArray(scope.actions)
        ? scope.actions.filter((action) => isJsonString(action))
        : [],
    }))
    .filter((scope) => scope.port && scope.resource && scope.actions.length > 0);
}

async function callScopedRequestToken({
  input,
  tokenBroker,
  auth,
  now,
  auditSink,
  toolCallId,
  issuedTokenRefs,
}) {
  if (!tokenBroker || !(tokenBroker.requestToken instanceof Function)) {
    return failure("request_token", "MCP_TOOL_UNBOUND", "request_token requires a token broker.");
  }

  const requested = requestedTokenScope(input.scope);
  if (!requested.ok) {
    return failure("request_token", "MCP_INPUT_INVALID", requested.message);
  }

  const narrowedSvidScope = narrowScope(auth.scopes, requested.scope);
  if (narrowedSvidScope.length === 0) {
    emitAudit(auditSink, {
      type: "policy.Decided",
      time: toIso(now),
      data: {
        decision: "deny",
        reason: "requested token scope exceeds SVID scope",
        subject: auth.principal,
        svidId: auth.svid.id,
        tool: "request_token",
        toolCallId,
        requestedScope: requested.scope,
      },
    });
    return failure("request_token", "MCP_SCOPE_DENIED", "requested token scope exceeds SVID scope.");
  }

  const brokerResult = await tokenBroker.requestToken({
    ...input,
    subject: auth.principal,
    svidScope: narrowedSvidScope,
  });
  const sanitized = sanitizeTokenResult(brokerResult, {
    now,
    toolCallId,
    issuedTokenRefs,
    auditSink,
  });

  return success("request_token", sanitized);
}

function requestedTokenScope(scope) {
  if (!isPlainObject(scope)) {
    return { ok: false, message: "scope must include port, resource, and action" };
  }
  for (const field of ["port", "resource", "action"]) {
    if (!isJsonString(scope[field]) || scope[field].length === 0) {
      return { ok: false, message: `scope.${field} must be a non-empty string` };
    }
  }
  return {
    ok: true,
    scope: {
      port: scope.port,
      resource: scope.resource,
      action: scope.action,
    },
  };
}

function requestedAction(capability) {
  return {
    port: capability.port,
    resource: capability.resource,
    action: capability.actions[0],
  };
}

function narrowScope(scopes, requested) {
  if (!scopeAllows(scopes, requested)) {
    return [];
  }
  return [
    {
      port: requested.port,
      resource: requested.resource,
      actions: [requested.action],
    },
  ];
}

function scopeAllows(scopes, requested) {
  return scopes.some((scope) =>
    scope.port === requested.port &&
    (scope.resource === requested.resource || scope.resource === "*") &&
    (scope.actions.includes(requested.action) || scope.actions.includes("*")),
  );
}

function sanitizeTokenResult(result, { now, toolCallId, issuedTokenRefs, auditSink }) {
  const sanitized = stripSecrets(clone(result ?? {}));
  if (isPlainObject(sanitized.credential)) {
    sanitized.credential = normalizeShortLivedCredential(sanitized.credential, now);
    if (isJsonString(sanitized.credential.tokenRef)) {
      issuedTokenRefs.add(sanitized.credential.tokenRef);
    }
  }

  const events = Array.isArray(sanitized.events) ? sanitized.events : [];
  sanitized.events = events.map((event) => withToolAuditContext(event, toolCallId));
  for (const event of sanitized.events) {
    if (isJsonString(event.type) && event.type.startsWith("token.")) {
      emitAudit(auditSink, event);
    }
  }

  return sanitized;
}

function normalizeShortLivedCredential(credential, now) {
  const normalized = { ...credential };
  const maxExpiresAt = new Date(currentTime(now).getTime() + 5 * 60 * 1000);
  if (!normalized.expiresAt || new Date(normalized.expiresAt).getTime() > maxExpiresAt.getTime()) {
    normalized.expiresAt = maxExpiresAt.toISOString();
  }
  return normalized;
}

function withToolAuditContext(event, toolCallId) {
  const normalized = isPlainObject(event) ? event : { type: "token.Unknown", data: {} };
  return {
    ...normalized,
    data: {
      ...(isPlainObject(normalized.data) ? normalized.data : undefined),
      tool: "request_token",
      toolCallId,
    },
  };
}

function validateInput(inputSchema, input) {
  if (!isPlainObject(input)) {
    return { ok: false, message: "input must be an object" };
  }

  for (const field of inputSchema.required ?? []) {
    if (input[field] === undefined) {
      return { ok: false, message: `${field} is required` };
    }
  }

  return { ok: true };
}

function publicTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    access: spec.access,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    annotations: spec.annotations,
  };
}

function stripSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const stripped = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      continue;
    }
    stripped[key] = stripSecrets(entry);
  }
  return stripped;
}

function isSecretKey(key) {
  return ["accessToken", "secret", "token", "value", "refreshToken", "idToken", "privateKey"].includes(key);
}

function emitAudit(auditSink, event) {
  auditSink(event);
}

function success(toolName, data) {
  return { ok: data?.ok ?? true, tool: toolName, data };
}

function failure(toolName, code, message) {
  return {
    ok: false,
    tool: toolName,
    error: { code, message },
  };
}

function toIso(now) {
  return currentTime(now).toISOString();
}

function currentTime(now) {
  const value = now();
  return value instanceof Date ? value : new Date(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
