export function web(id, options = {}) {
  return Object.freeze({ kind: "web", id, ...options });
}

export function service(id, options = {}) {
  return Object.freeze({ kind: "service", id, ...options });
}

export function trafficSplit(steps) {
  for (const step of steps) {
    if (!Number.isFinite(step.weight) || step.weight <= 0) {
      throw new Error(`traffic split weight must be positive for ${step.target}`);
    }
  }

  const total = steps.reduce((sum, step) => sum + step.weight, 0);

  if (total !== 100) {
    throw new Error(`traffic split weights must sum to 100, got ${total}`);
  }

  return Object.freeze({
    kind: "traffic-split",
    steps: steps.map((step) => Object.freeze({ target: step.target, weight: step.weight })),
  });
}

export function gatewayPort(id) {
  const draft = {
    id,
    tls: undefined,
    routes: [],
    providerOptions: {},
    mountedOrigins: [],
  };

  return {
    terminateTls(options = {}) {
      draft.tls = { mode: "terminate", ...options };
      return this;
    },
    route(host, path, target, split = undefined) {
      draft.routes.push({ host, path, target, split });
      return this;
    },
    with(providerOptions) {
      draft.providerOptions = structuredClone(providerOptions);
      return this;
    },
    mount(host, path, ui) {
      draft.routes.push({ host, path, target: ui, split: undefined });
      if (ui.origin) {
        draft.mountedOrigins.push(ui.origin);
      }
      return this;
    },
    build() {
      const allowOrigins = [...new Set(draft.mountedOrigins.map(normalizeOrigin))].sort();
      const hasVerticalOrigins = allowOrigins.length > 0;

      return Object.freeze({
        id: draft.id,
        tls: Object.freeze(draft.tls ?? { mode: "passthrough" }),
        providerOptions: Object.freeze(structuredClone(draft.providerOptions)),
        cors: Object.freeze({
          allowOrigins,
          methods: hasVerticalOrigins ? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] : [],
          credentials: hasVerticalOrigins,
        }),
        routes: draft.routes.map((route) => Object.freeze({ ...route })),
      });
    },
  };
}

function normalizeOrigin(origin) {
  let parsed;

  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`invalid origin: ${origin}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error(`invalid origin: ${origin}`);
  }

  return parsed.origin;
}

export function createGatewayStub(gateway) {
  return {
    handle(request) {
      if (gateway.tls.mode === "terminate" && request.scheme !== "https") {
        throw new Error("gateway requires https for TLS termination");
      }

      const route = gateway.routes
        .filter((candidate) => candidate.host === request.host)
        .filter((candidate) => pathMatches(candidate.path, request.path))
        .sort((left, right) => right.path.length - left.path.length)[0];

      if (!route) {
        throw new Error(`no gateway route for ${request.host}${request.path}`);
      }

      return {
        tls: { terminated: gateway.tls.mode === "terminate" },
        route: { host: route.host, path: route.path },
        target: route.target,
        split: route.split,
      };
    },
  };
}

function pathMatches(routePath, requestPath) {
  return routePath === "/" || requestPath === routePath || requestPath.startsWith(`${routePath}/`);
}
