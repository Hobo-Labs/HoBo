type Template = "todo" | "api" | "agent" | "fullstack";
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
type StoreValue = Record<string, string>;
type StoreRecord = { key: string; value: StoreValue };

interface Store {
	kind: string;
	put(key: string, value: StoreValue): Promise<StoreRecord>;
	get(key: string): Promise<StoreValue | null>;
}

interface Resource {
	name: string;
	store: Store;
	put(key: string, value: StoreValue): Promise<StoreRecord>;
	get(key: string): Promise<StoreValue | null>;
}

interface HandlerRequest {
	path: string;
}

interface HandlerResponse {
	status: number;
	body: {
		template: Template;
		path: string;
		[key: string]: JsonValue;
	};
}

interface Handler {
	route: string;
	run(request: HandlerRequest): Promise<HandlerResponse>;
}

interface Hobo {
	resource(name: string, store: Store): Resource;
	api(
		route: string,
		handler: (request: HandlerRequest) => Promise<HandlerResponse>,
	): Handler;
}

export function createHobo(options: {
	name: string;
	template: Template;
}): Hobo {
	void options;

	return {
		resource(name: string, store: Store): Resource {
			return {
				name,
				store,
				put: store.put.bind(store),
				get: store.get.bind(store),
			};
		},
		api(
			route: string,
			handler: (request: HandlerRequest) => Promise<HandlerResponse>,
		): Handler {
			return {
				route,
				run: handler,
			};
		},
	};
}

export function createApiStore(): Store {
	return createMemoryStore("api");
}

export function createTodoStore(): Store {
	return createMemoryStore("todo");
}

export function createAgentStore(): Store {
	return createMemoryStore("agent");
}

export function createFullstackStore(): Store {
	return createMemoryStore("fullstack");
}

export function createTestRuntime({
	app,
	template,
}: {
	app: string;
	template: Template;
}) {
	return {
		app,
		template,
		async expectResource(resource: Resource, name: string) {
			if (resource.name !== name) {
				throw new Error(`Expected resource ${name}, got ${resource.name}`);
			}
		},
		async expectHandler(handler: Handler, route: string) {
			if (handler.route !== route) {
				throw new Error(`Expected route ${route}, got ${handler.route}`);
			}
		},
		async expectResponse(
			handler: Handler,
			request: { path: string; body: { template: Template } },
		) {
			const response = await handler.run({ path: request.path });
			if (response.body.template !== request.body.template) {
				throw new Error(
					`Expected template ${request.body.template}, got ${response.body.template}`,
				);
			}
		},
	};
}

function createMemoryStore(kind: string): Store {
	const values = new Map<string, StoreValue>();
	return {
		kind,
		async put(key: string, value: StoreValue): Promise<StoreRecord> {
			values.set(key, value);
			return { key, value };
		},
		async get(key: string): Promise<StoreValue | null> {
			return values.get(key) ?? null;
		},
	};
}
