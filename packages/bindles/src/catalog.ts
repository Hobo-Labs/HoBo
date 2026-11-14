import { isJsonString, type JsonValue } from "./json.js";
import type {
	AllowVerbsFor,
	LoweringDescriptor,
	ResourceCatalogEntry,
	ResourceDescriptor,
	ResourceHandle,
	ResourceKind,
} from "./types.js";
import { CATALOG_ROWS } from "./types.js";

export const CATALOG: readonly ResourceCatalogEntry[] = Object.freeze(
	CATALOG_ROWS.map((row) =>
		Object.freeze({
			factory: row.factory,
			portRef: Object.freeze([...row.portRef]),
			allowVerbs: Object.freeze([...row.allowVerbs]),
		}),
	),
);

const catalogByFactory = new Map<ResourceKind, (typeof CATALOG_ROWS)[number]>(
	CATALOG_ROWS.map((row) => [row.factory, row]),
);

export function catalogFactoryNames(): ResourceKind[] {
	return CATALOG_ROWS.map((row) => row.factory);
}

function requireResourceName(factory: string, name: string): void {
	if (!isJsonString(name) || name.length === 0) {
		throw new TypeError(`${factory} resource name must be a non-empty string`);
	}
}

interface LoweringHandle {
	readonly kind: ResourceKind;
	readonly name: string;
	readonly stableId: string;
	readonly portRef: readonly string[];
}

function makeLoweringDescriptor(
	handle: LoweringHandle,
	verb: string,
	args: JsonValue[],
): LoweringDescriptor {
	return Object.freeze({
		lowersTo: "hobo:sdk",
		kind: handle.kind,
		name: handle.name,
		handleStableId: handle.stableId,
		portRef: handle.portRef,
		verb,
		args: Object.freeze([...args]),
	});
}

function createHandle<K extends ResourceKind>(
	kind: K,
	name: string,
	declaredAllow: readonly AllowVerbsFor<K>[] = [],
): ResourceHandle<K> {
	requireResourceName(kind, name);
	const entry = catalogByFactory.get(kind);
	if (!entry) {
		throw new Error(`unknown catalog factory: ${kind}`);
	}

	// SAFETY: assertion required at this I/O or test boundary.
	const stableId = `${kind}:${name}` as `${K}:${string}`;
	// SAFETY: assertion required at this I/O or test boundary.
	const portRef = [...entry.portRef] as readonly string[];

	const handle = {
		kind,
		name,
		stableId,
		portRef,
		identity: Object.freeze({ kind, name, stableId }),
		declaredAllow: Object.freeze([...declaredAllow]),
		allow<V extends AllowVerbsFor<K>>(...verbs: V[]): ResourceHandle<K, V> {
			for (const verb of verbs) {
				// SAFETY: assertion required at this I/O or test boundary.
				if (!(entry.allowVerbs as readonly string[]).includes(verb as string)) {
					throw new TypeError(`${kind} does not allow verb "${String(verb)}"`);
				}
			}
			// SAFETY: assertion required at this I/O or test boundary.
			return createHandle(kind, name, verbs) as ResourceHandle<K, V>;
		},
		toDescriptor(): ResourceDescriptor<K> {
			return Object.freeze({
				kind,
				name,
				stableId,
				portRef,
				allowVerbs: Object.freeze([...entry.allowVerbs]),
				declaredAllow: Object.freeze([...handle.declaredAllow]),
			});
		},
	};

	for (const verb of entry.allowVerbs) {
		Object.defineProperty(handle, verb, {
			enumerable: true,
			value: (...args: JsonValue[]) =>
				makeLoweringDescriptor(handle, verb, args),
		});
	}

	// SAFETY: assertion required at this I/O or test boundary.
	return Object.freeze(handle) as ResourceHandle<K>;
}

export function api(name: string): ResourceHandle<"api"> {
	return createHandle("api", name);
}
export function kv(name: string): ResourceHandle<"kv"> {
	return createHandle("kv", name);
}
export function bucket(name: string): ResourceHandle<"bucket"> {
	return createHandle("bucket", name);
}
export function queue(name: string): ResourceHandle<"queue"> {
	return createHandle("queue", name);
}
export function topic(name: string): ResourceHandle<"topic"> {
	return createHandle("topic", name);
}
export function secret(name: string): ResourceHandle<"secret"> {
	return createHandle("secret", name);
}
export function data(name: string): ResourceHandle<"data"> {
	return createHandle("data", name);
}
export function schedule(name: string): ResourceHandle<"schedule"> {
	return createHandle("schedule", name);
}
export function project(name: string): ResourceHandle<"project"> {
	return createHandle("project", name);
}
export function websocket(name: string): ResourceHandle<"websocket"> {
	return createHandle("websocket", name);
}
export function job(name: string): ResourceHandle<"job"> {
	return createHandle("job", name);
}
export function web(name: string): ResourceHandle<"web"> {
	return createHandle("web", name);
}
export function service(name: string): ResourceHandle<"service"> {
	return createHandle("service", name);
}
export function flag(name: string): ResourceHandle<"flag"> {
	return createHandle("flag", name);
}
export function auth(name: string): ResourceHandle<"auth"> {
	return createHandle("auth", name);
}
export function crypto(name: string): ResourceHandle<"crypto"> {
	return createHandle("crypto", name);
}
export function notify(name: string): ResourceHandle<"notify"> {
	return createHandle("notify", name);
}
export function guardrail(name: string): ResourceHandle<"guardrail"> {
	return createHandle("guardrail", name);
}
export function ui(name: string): ResourceHandle<"ui"> {
	return createHandle("ui", name);
}
export function experiment(name: string): ResourceHandle<"experiment"> {
	return createHandle("experiment", name);
}
export function rolloutResource(name: string): ResourceHandle<"rollout"> {
	return createHandle("rollout", name);
}
