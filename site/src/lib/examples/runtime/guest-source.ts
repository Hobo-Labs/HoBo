import type {
	BrowserStationRequest,
	BrowserStationResponse,
} from "../../../_generated/browser_station_pb.js";
import type { ExampleRuntimeDescriptor } from "../catalog-contract.js";

export type BrowserRuntimeDescriptor = ExampleRuntimeDescriptor;
export type BrowserStationInvokeRequest = Pick<
	BrowserStationRequest,
	"exampleId" | "stationId" | "method" | "path" | "bodyJson"
>;
export type BrowserStationInvokeResponse = Pick<
	BrowserStationResponse,
	"status" | "bodyJson"
>;

export interface BrowserRuntimeExample {
	readonly id: string;
	readonly runtime: BrowserRuntimeDescriptor;
	/** Object-literal source from examples/try-site/apps/<id>/handlers.txt */
	readonly handlersSource?: string;
}

/**
 * Produce the JavaScript guest compiled by componentize-js. Runtime descriptors
 * plus per-example handler objects are the executable contract.
 */
export function buildBrowserStationGuestSource(
	examples: readonly BrowserRuntimeExample[],
): string {
	const descriptors = Object.fromEntries(
		examples.map(({ id, runtime }) => [id, runtime]),
	);
	const handlerEntries = examples
		.filter((example) => (example.handlersSource ?? "").trim().length > 0)
		.map((example) => {
			const body = example.handlersSource!.trim().replace(/;?\s*$/u, "");
			return `  ${JSON.stringify(example.id)}: (${body})`;
		});
	const exampleHandlers = `{\n${handlerEntries.join(",\n")}\n}`;

	return `
const descriptors = ${safeJson(descriptors)};
const exampleHandlers = ${exampleHandlers};
const states = Object.create(null);
let sequence = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateFor(exampleId, descriptor) {
  if (states[exampleId]) return states[exampleId];
  const state = Object.create(null);
  for (const [name, resource] of Object.entries(descriptor.resources)) {
    state[name] = clone(resource.initial);
  }
  states[exampleId] = state;
  return state;
}

function response(status, body) {
  return { status, bodyJson: JSON.stringify(body) };
}

function nextId() {
  return String(++sequence);
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export function invoke(request) {
  let body;
  try {
    body = JSON.parse(request.bodyJson);
  } catch {
    return response(400, { error: "invalid JSON body" });
  }
  const descriptor = descriptors[request.exampleId];
  if (!descriptor) return response(404, { error: "unknown example" });
  const route = descriptor.routes.find(
    (candidate) => candidate.method === request.method && candidate.path === request.path,
  );
  if (!route) return response(404, { error: "route not found" });
  const state = stateFor(request.exampleId, descriptor);
  const value = route.resource ? state[route.resource] : undefined;
  if (route.resource && value === undefined) {
    return response(500, { error: "declared resource not found" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};

  const ctx = {
    body,
    state,
    value,
    route,
    request,
    response,
    clone,
    nextId,
    publicUser,
  };

  switch (route.action) {
    case "health":
      return response(200, { ok: true, station: request.stationId || null });
    case "read":
      return response(200, route.key ? { [route.key]: value[route.key] } : clone(value));
    case "list":
      return response(200, { items: clone(value) });
    case "increment": {
      const key = route.key || "count";
      const by = Number.isFinite(Number(body.by)) ? Number(body.by) : 1;
      value[key] = Number(value[key] || 0) + by;
      return response(200, { [key]: value[key] });
    }
    case "reset": {
      const key = route.key || "count";
      value[key] = 0;
      return response(200, { [key]: 0 });
    }
    case "create": {
      const item = { ...body, id: nextId() };
      value.push(item);
      return response(201, clone(item));
    }
    case "delete": {
      const index = value.findIndex((candidate) => String(candidate.id) === String(body.id));
      if (index === -1) return response(404, { error: "item not found" });
      const [item] = value.splice(index, 1);
      return response(200, clone(item));
    }
    case "toggle": {
      const item = value.find((candidate) => String(candidate.id) === String(body.id));
      if (!item) return response(404, { error: "item not found" });
      item.completed = !item.completed;
      return response(200, clone(item));
    }
    case "enqueue": {
      const item = { id: nextId(), message: String(body.message || body.text || "") };
      value.push(item);
      return response(202, clone(item));
    }
    case "drain":
      return response(200, { item: value.shift() || null, remaining: value.length });
    default: {
      const handlers = exampleHandlers[request.exampleId];
      const handler = handlers && handlers[route.action];
      if (typeof handler !== "function") {
        return response(500, { error: "unsupported runtime action" });
      }
      return handler(ctx);
    }
  }
}
`.trimStart();
}

function safeJson(value: BrowserRuntimeDescriptor | Record<string, BrowserRuntimeDescriptor>): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}
