import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const GATEWAY_REALIZATION_CONTRACT_VERSION = "hobo.gateway-realization/v1";
const DEFAULT_CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export function realizeGateway(gateway, options = {}) {
  assertObject(gateway, "gateway");
  if (!isJsonString(gateway.id) || gateway.id.length === 0) {
    throw new Error("gateway requires a non-empty id");
  }

  const tls = normalizeTls(gateway.tls);
  const routes = (gateway.routes ?? []).map((route, index) => realizeRoute(route, index, options.health ?? {}));

  return deepFreeze({
    version: GATEWAY_REALIZATION_CONTRACT_VERSION,
    provider: options.provider ?? "local-gateway",
    gatewayId: gateway.id,
    listeners: [
      {
        protocol: tls.mode === "terminate" ? "https" : "tcp",
        tlsTerminated: tls.mode === "terminate",
        tls,
      },
    ],
    providerOptions: clone(gateway.providerOptions ?? {}),
    cors: normalizeCors(gateway.cors),
    routes,
  });
}

export function planGatewayRequest(deployment, request) {
  assertObject(deployment, "deployment");
  assertObject(request, "request");

  const listener = deployment.listeners?.[0];
  if (!listener) {
    throw new Error("deployment requires a listener");
  }
  if (listener.tlsTerminated && request.scheme !== "https") {
    return failure(426, "tls-required", { listener: clone(listener) });
  }

  const route = findRoute(deployment.routes ?? [], request);
  if (!route) {
    return failure(404, "no-route", { listener: clone(listener) });
  }

  const selectedBackend = selectBackend(route, request);
  const backend = route.backends.find((candidate) => candidate.id === selectedBackend);
  if (!backend) {
    throw new Error(`route ${route.id} selected unknown backend ${selectedBackend}`);
  }

  const target = route.split ? route.target : backend.target;
  if (backend.health !== "healthy") {
    return failure(503, "backend-unhealthy", {
      listener: clone(listener),
      route: routeSummary(route),
      target: clone(target),
      selectedBackend,
    });
  }

  return {
    served: true,
    status: 200,
    tls: { terminated: listener.tlsTerminated },
    listener: clone(listener),
    route: routeSummary(route),
    target: clone(target),
    selectedBackend,
    cors: clone(deployment.cors),
  };
}

function realizeRoute(route, index, health) {
  assertObject(route, "route");
  if (!isJsonString(route.host) || route.host.length === 0) {
    throw new Error("route requires a host");
  }
  if (!isJsonString(route.path) || !route.path.startsWith("/")) {
    throw new Error(`route for ${route.host} requires an absolute path`);
  }

  const split = route.split === undefined ? undefined : normalizeSplit(route.split);
  const target = clone(route.target);
  const backends = split
    ? split.steps.map((step) => backend(step.target, { id: step.target }, health))
    : [backend(targetKey(route.target), target, health)];

  return {
    id: `${route.host}${route.path}#${index}`,
    host: route.host,
    path: route.path,
    target,
    split,
    backends,
  };
}

function normalizeSplit(split) {
  assertObject(split, "traffic split");
  if (split.kind !== "traffic-split") {
    throw new Error(`unsupported split kind ${split.kind}`);
  }
  if (!Array.isArray(split.steps) || split.steps.length === 0) {
    throw new Error("traffic split requires steps");
  }

  let total = 0;
  const steps = split.steps.map((step) => {
    if (!isJsonString(step.target) || step.target.length === 0) {
      throw new Error("traffic split step requires a target");
    }
    if (!Number.isFinite(step.weight) || step.weight <= 0) {
      throw new Error(`traffic split weight must be positive for ${step.target}`);
    }
    total += step.weight;
    return { target: step.target, weight: step.weight };
  });

  if (total !== 100) {
    throw new Error(`traffic split weights must sum to 100, got ${total}`);
  }

  return { kind: "traffic-split", steps };
}

function selectBackend(route, request) {
  if (!route.split) {
    return route.backends[0].id;
  }

  const roll = normalizeRoll(request.roll ?? stableRoll(request));
  let upperBound = 0;

  for (const step of route.split.steps) {
    upperBound += step.weight;
    if (roll < upperBound) {
      return step.target;
    }
  }

  return route.split.steps.at(-1).target;
}

function normalizeRoll(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 100) {
    throw new Error(`traffic split roll must be an integer from 0 to 99, got ${value}`);
  }
  return value;
}

function stableRoll(request) {
  const digest = createHash("sha256")
    .update(`${request.method ?? "GET"} ${request.host ?? ""}${request.path ?? ""}`)
    .digest();
  return digest[0] % 100;
}

function findRoute(routes, request) {
  return routes
    .filter((route) => route.host === request.host)
    .filter((route) => pathMatches(route.path, request.path ?? "/"))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function pathMatches(routePath, requestPath) {
  return routePath === "/" || requestPath === routePath || requestPath.startsWith(`${routePath}/`);
}

function backend(id, target, health) {
  return {
    id,
    target: clone(target),
    health: normalizeHealth(health[id] ?? "healthy"),
  };
}

function targetKey(target) {
  if (isJsonString(target)) {
    return target;
  }
  if (target && isJsonString(target.id) && target.id.length > 0) {
    return target.id;
  }
  throw new Error("route target requires an id");
}

function normalizeHealth(value) {
  if (value === true) return "healthy";
  if (value === false) return "unhealthy";
  if (value === "healthy" || value === "unhealthy") return value;
  throw new Error(`unknown backend health ${value}`);
}

function normalizeTls(tls = { mode: "passthrough" }) {
  assertObject(tls, "tls");
  if (!["terminate", "passthrough"].includes(tls.mode)) {
    throw new Error(`unsupported TLS mode ${tls.mode}`);
  }
  return clone(tls);
}

function normalizeCors(cors = {}) {
  const allowOrigins = [...new Set(cors.allowOrigins ?? [])].sort();
  for (const origin of allowOrigins) {
    validateOrigin(origin);
  }

  if (allowOrigins.length === 0) {
    return {
      allowOrigins: [],
      methods: [],
      credentials: false,
    };
  }

  return {
    allowOrigins,
    methods: [...(cors.methods ?? DEFAULT_CORS_METHODS)],
    credentials: cors.credentials ?? true,
  };
}

function validateOrigin(origin) {
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("invalid origin");
    }
  } catch {
    throw new Error(`invalid CORS origin: ${origin}`);
  }
}

function routeSummary(route) {
  return {
    id: route.id,
    host: route.host,
    path: route.path,
  };
}

function failure(status, reason, extra = {}) {
  return {
    served: false,
    status,
    reason,
    ...extra,
  };
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
