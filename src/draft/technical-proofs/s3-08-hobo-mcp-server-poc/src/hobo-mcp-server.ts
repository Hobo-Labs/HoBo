import { CANONICAL_VERBS } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import {
  assertCliParity,
  createHoboMcpServer,
  DOCUMENTED_MCP_TOOLS,
  MCP_TOOL_SPECS,
} from "../../hobo-mcp-server-contract/src/mcp-server-contract.js";
import { createSvidBoundHoboMcpServer } from "../../hobo-mcp-server-contract/src/mcp-svid-auth.js";
import {
  assertOperationsManifestFresh,
  generateOperationsManifests,
  serveOperationsManifest,
  validateDocsJson,
} from "../../operations-manifests-contract/src/operations-manifests.js";
import { isJsonNumber } from "./json.js";


export const MCP_GATEWAY_CONTRACT_VERSION = "hobo.mcp-gateway/v1";
export const MCP_RATE_LIMIT_ERROR = "MCP_RATE_LIMITED";

export const DEFAULT_RATE_LIMITS = Object.freeze({
  perPrincipal: { windowMs: 1_000, maxRequests: 5 },
  perTenant: { windowMs: 1_000, maxRequests: 20 },
});

export function createRateLimiter(limits = DEFAULT_RATE_LIMITS) {
  const buckets = new Map();

  return Object.freeze({
    check(key, now = Date.now()) {
      const isTenant = key.startsWith("tenant:");
      const windowMs = isTenant ? limits.perTenant.windowMs : limits.perPrincipal.windowMs;
      const max = isTenant ? limits.perTenant.maxRequests : limits.perPrincipal.maxRequests;

      const bucket = buckets.get(key) ?? { windowStart: now, count: 0 };
      if (now - bucket.windowStart >= windowMs) {
        bucket.windowStart = now;
        bucket.count = 0;
      }
      bucket.count += 1;
      buckets.set(key, bucket);

      if (bucket.count > max) {
        const retryAfterMs = windowMs - (now - bucket.windowStart);
        return {
          ok: false,
          code: MCP_RATE_LIMIT_ERROR,
          message: `rate limit exceeded for ${key}`,
          retryAfterMs: Math.max(retryAfterMs, 1),
        };
      }

      return { ok: true };
    },

    reset() {
      buckets.clear();
    },
  });
}

export function createHoboMcpGatewayServer(options = {}) {
  const rateLimiter = options.rateLimiter ?? createRateLimiter(options.rateLimits);
  const auditSink = options.auditSink ?? (() => {});
  const gatewayCalls = [];
  let lastPrincipal = null;

  const verifySvid = options.verifySvid
    ? async (assertion, context) => {
        const result = await options.verifySvid(assertion, context);
        if (result?.ok) {
          lastPrincipal = result.principal ?? result.subject ?? null;
        }
        return result;
      }
    : undefined;

  const inner = createSvidBoundHoboMcpServer({
    ...options,
    verifySvid,
    auditSink: (event) => {
      auditSink(event);
      options.auditSink?.(event);
    },
  });

  const manifests = generateOperationsManifests({
    verbs: CANONICAL_VERBS,
    tools: MCP_TOOL_SPECS,
  });

  return Object.freeze({
    contractVersion: MCP_GATEWAY_CONTRACT_VERSION,

    listTools() {
      return inner.listTools();
    },

    listTransports() {
      return inner.listTransports();
    },

    operationsManifests() {
      return manifests;
    },

    serveManifest(path) {
      return serveOperationsManifest(path, manifests);
    },

    async callTool(name, input = {}, callOptions = {}) {
      if (verifySvid && options.svidAssertion) {
        const auth = await verifySvid(options.svidAssertion, {
          tool: name,
          toolCallId: callOptions.toolCallId,
        });
        if (auth?.ok) {
          lastPrincipal = auth.principal ?? auth.subject ?? null;
        }
      }

      const principal = lastPrincipal;
      const tenantId = principal?.tenantId ?? principal?.tenant ?? "tenant:unknown";
      const principalId = principal?.id ?? "anonymous";
      const now = isJsonNumber(callOptions.now) ? callOptions.now : Date.now();

      const principalCheck = rateLimiter.check(`principal:${principalId}`, now);
      if (!principalCheck.ok) {
        emitThrottleAudit(auditSink, { principalId, tenantId, tool: name, ...principalCheck });
        return throttleFailure(name, principalCheck);
      }

      const tenantCheck = rateLimiter.check(`tenant:${tenantId}`, now);
      if (!tenantCheck.ok) {
        emitThrottleAudit(auditSink, { principalId, tenantId, tool: name, ...tenantCheck });
        return throttleFailure(name, tenantCheck);
      }

      gatewayCalls.push({
        tool: name,
        principalId,
        tenantId,
        path: "gateway->cli",
      });

      const result = await inner.callTool(name, input, callOptions);

      if (result.error?.code === "MCP_AUTH_REQUIRED" || result.error?.code === "MCP_AUTH_INVALID") {
        gatewayCalls.pop();
      }

      return result;
    },

    getGatewayCalls() {
      return gatewayCalls.map((call) => ({ ...call }));
    },
  });
}

export function assertSurfaceParity(toolSpecs = MCP_TOOL_SPECS, verbs = CANONICAL_VERBS) {
  const parity = assertCliParity(toolSpecs, verbs);
  const toolNames = new Set(toolSpecs.map((spec) => spec.name));

  for (const documented of DOCUMENTED_MCP_TOOLS) {
    if (!toolNames.has(documented)) {
      throw new Error(`NFR-004 surface parity: missing documented MCP tool ${documented}`);
    }
  }

  const manifests = generateOperationsManifests({ verbs, tools: toolSpecs });
  assertOperationsManifestFresh({ manifests, verbs, tools: toolSpecs });
  const docs = JSON.parse(manifests["docs.json"]);
  const validation = validateDocsJson(docs);
  if (!validation.ok) {
    throw new Error(`operations docs.json invalid: ${validation.errors.join("; ")}`);
  }

  return {
    ok: true,
    parity,
    documentedTools: DOCUMENTED_MCP_TOOLS.length,
    cliVerbs: verbs.length,
    manifestPaths: ["/llms.txt", "/llms-full.txt", "/docs.json"],
  };
}

export function createFixtureMcpGateway(options = {}) {
  const scopes = MCP_TOOL_SPECS.map((tool) => ({
    port: "hobo:mcp",
    resource: `tool:${tool.name}`,
    actions: ["call"],
  }));

  return createHoboMcpGatewayServer({
    svidAssertion: "fixture-svid",
    now: () => new Date("2026-07-01T12:00:00.000Z"),
    verifySvid: async () => ({
      ok: true,
      principal: {
        kind: "agent",
        id: options.principalId ?? "agent:fixture",
        tenantId: options.tenantId ?? "tenant:acme",
      },
      svid: {
        id: "spiffe://yard/acme/agent/fixture",
        expiresAt: "2026-07-02T12:00:00.000Z",
      },
      scopes,
    }),
    cli: options.cli,
    rateLimiter: options.rateLimiter,
    rateLimits: options.rateLimits,
    auditSink: options.auditSink,
    handlers: options.handlers,
    tokenBroker: options.tokenBroker,
  });
}

export { createHoboMcpServer, createSvidBoundHoboMcpServer, MCP_TOOL_SPECS, DOCUMENTED_MCP_TOOLS };

function throttleFailure(toolName, check) {
  return {
    ok: false,
    tool: toolName,
    error: {
      code: check.code,
      message: check.message,
      retryAfterMs: check.retryAfterMs,
    },
    throttled: true,
  };
}

function emitThrottleAudit(sink, event) {
  sink({
    type: "gateway.RateLimited",
    time: new Date().toISOString(),
    data: event,
  });
}
