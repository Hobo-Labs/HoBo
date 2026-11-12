/**
 * A local stand-in for the Durable Object namespace and its storage, for
 * tests and local runs of the real handler and `ConfigStore` class. Faithful
 * where the store depends on it: one instance per name, values stored as
 * structured clones, a multi-key `put` that lands at once, `list` by prefix
 * in key order, and one request at a time per instance, the way a Durable
 * Object's input gate delivers them while storage runs. The workerd suite
 * (`test/miniflare.test.ts`) runs the real runtime.
 */
import {
	type ConfigServiceEnv,
	createConfigServiceHandler,
	type StoreNamespace,
	type StoreObjectId,
} from "./worker/handler.js";
import type { JsonValue } from "./worker/json.js";
import { ConfigStore, type DurableObjectStateLike } from "./worker/store.js";

function stateOver(storage: Map<string, JsonValue>): DurableObjectStateLike {
	return {
		storage: {
			async get(key) {
				return structuredClone(storage.get(key));
			},
			async put(entries) {
				const staged = Object.entries(entries).map(
					([key, value]) => [key, structuredClone(value)] as const,
				);
				for (const [key, value] of staged) storage.set(key, value);
			},
			async delete(keys) {
				let count = 0;
				for (const key of keys) if (storage.delete(key)) count += 1;
				return count;
			},
			async list({ prefix }) {
				return new Map(
					[...storage.entries()]
						.filter(([key]) => key.startsWith(prefix))
						.sort(([a], [b]) => (a < b ? -1 : 1))
						.map(([key, value]) => [key, structuredClone(value)]),
				);
			},
		},
	};
}

export type InMemoryConfigService = Readonly<{
	namespace: StoreNamespace;
	storage: Map<string, JsonValue>;
	env: ConfigServiceEnv;
	/** The Worker, `fetch`-shaped: any URL, the path decides. */
	fetch: typeof fetch;
}>;

/** The real Worker over in-memory storage; `issuers` reaches the OIDC key endpoints. */
export function createInMemoryConfigService(
	vars: Readonly<{
		HOBO_CONFIG_BINDING: string;
		HOBO_CONFIG_OWNER_ACCESS?: string;
	}>,
	issuers: typeof fetch,
): InMemoryConfigService {
	const storage = new Map<string, JsonValue>();
	const objects = new Map<string, ConfigStore>();
	const ids = new Map<string, StoreObjectId>();
	const names = new Map<StoreObjectId, string>();
	let queue: Promise<Response | undefined> = Promise.resolve(undefined);
	const namespace: StoreNamespace = {
		idFromName(name) {
			const known = ids.get(name);
			if (known !== undefined) return known;
			// SAFETY: an opaque token; the stand-in maps it back to its name.
			const id = {} as StoreObjectId;
			ids.set(name, id);
			names.set(id, name);
			return id;
		},
		get(id) {
			const name = names.get(id) ?? "";
			let object = objects.get(name);
			if (object === undefined) {
				object = new ConfigStore(stateOver(storage), vars);
				objects.set(name, object);
			}
			const target = object;
			return {
				fetch(request) {
					const run = queue.then(() => target.fetch(request));
					queue = run.catch(() => undefined);
					return run;
				},
			};
		},
	};
	const env: ConfigServiceEnv = { CONFIG_STORE: namespace, ...vars };
	const handler = createConfigServiceHandler(issuers);
	return {
		namespace,
		storage,
		env,
		fetch: async (input, init) => handler.fetch(new Request(input, init), env),
	};
}
