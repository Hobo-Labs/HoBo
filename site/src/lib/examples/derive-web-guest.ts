import type { BindleDefinition } from "@hobo/bindles";

import {
	isInspectableFunction,
	type Inspectable,
} from "../json-inspect.js";
import type { ExampleRuntimeDescriptor, RuntimeAction } from "./catalog-contract.js";
import { synthesizeTryRuntimeFromDeclared } from "./synthesize-try-runtime.js";

export type WebGuestFromBindle = {
	readonly runtime: ExampleRuntimeDescriptor;
	readonly guestHandlersSource: string;
};

type GuestMethod = (...args: Inspectable[]) => Inspectable;

interface WebGuestInstance {
	readonly [action: string]: GuestMethod | Inspectable | undefined;
}

const KV_BACKED_ACTIONS = new Set<RuntimeAction>([
	"list",
	"create",
	"toggle",
	"delete",
]);

/**
 * Derive try-runtime + guest handler object from a Bindle that binds a
 * trainable/component class to `web`. Guest handlers call the same method
 * bodies via Function#toString — Source pane never shows this machinery.
 *
 * When the Bindle also declares a `kv` resource and trainable ops are
 * list/create/toggle(/delete), emit kv-backed try-runtime routes and leave
 * guestHandlersSource empty so the browser guest uses built-in actions.
 */
export function deriveWebGuestFromBindle(
	definition: BindleDefinition,
	appSource: string,
): WebGuestFromBindle {
	const makeWeb = definition.entrypoint("web");
	const makeWebTag = Object.prototype.toString.call(makeWeb);
	if (
		makeWeb === undefined ||
		(makeWebTag !== "[object Function]" &&
			makeWebTag !== "[object AsyncFunction]")
	) {
		throw new TypeError(
			`Bindle "${definition.name}" has no web entrypoint — bind a trainable with b.web(Hello)`,
		);
	}
	// SAFETY: Bindle web constructors return an inspectable instance bag.
	const constructed = makeWeb() as Inspectable;
	if (!isInspectableRecord(constructed)) {
		throw new TypeError(
			`Bindle "${definition.name}" web entrypoint did not construct an instance`,
		);
	}
	const instance = constructed;

	const kvName = firstKvResourceName(definition);
	const baseRuntime = synthesizeTryRuntimeFromDeclared(appSource);
	const customActions = baseRuntime.routes
		.map((route) => route.action)
		.filter((action) => action !== "health");
	if (customActions.length === 0) {
		throw new TypeError(
			`Bindle "${definition.name}" web binding declares no trainable operations`,
		);
	}

	if (kvName && customActions.every((action) => KV_BACKED_ACTIONS.has(action))) {
		return {
			runtime: synthesizeKvBackedRuntime(kvName, customActions),
			guestHandlersSource: "",
		};
	}

	const handlerEntries: string[] = [];
	for (const action of customActions) {
		const method = instance[action];
		if (!isInspectableFunction(method)) {
			throw new TypeError(
				`Web instance for "${definition.name}" is missing method ${action}`,
			);
		}
		const implSource = callableSource(method);
		handlerEntries.push(`  ${JSON.stringify(action)}({ body, response }) {
    const impl = ${implSource};
    const raw = body && typeof body.name === "string" ? body.name.trim() : "";
    const arg = raw.length > 0 ? raw : undefined;
    const result = impl.call({}, arg);
    if (typeof result === "string") return response(200, { greeting: result });
    return response(200, result && typeof result === "object" ? result : { value: result });
  }`);
	}

	return {
		runtime: baseRuntime,
		guestHandlersSource: `{\n${handlerEntries.join(",\n")}\n}`,
	};
}

function firstKvResourceName(definition: BindleDefinition): string | null {
	for (const [name, resource] of Object.entries(definition.resources)) {
		if (resource?.kind === "kv") return name;
	}
	return null;
}

function synthesizeKvBackedRuntime(
	kvName: string,
	actions: readonly RuntimeAction[],
): ExampleRuntimeDescriptor {
	const collectionPath = `/api/${kebab(kvName)}`;
	const routes: ExampleRuntimeDescriptor["routes"][number][] = [
		{ method: "GET", path: "/health", action: "health" },
	];
	for (const action of actions) {
		if (action === "list") {
			routes.push({
				method: "GET",
				path: collectionPath,
				action: "list",
				resource: kvName,
			});
		} else if (action === "create") {
			routes.push({
				method: "POST",
				path: collectionPath,
				action: "create",
				resource: kvName,
			});
		} else if (action === "toggle") {
			routes.push({
				method: "PATCH",
				path: `${collectionPath}/:id`,
				action: "toggle",
				resource: kvName,
			});
		} else if (action === "delete") {
			routes.push({
				method: "DELETE",
				path: `${collectionPath}/:id`,
				action: "delete",
				resource: kvName,
			});
		}
	}
	return {
		schemaVersion: "hobo.try-runtime/v1",
		resources: { [kvName]: { kind: "kv", initial: [] } },
		routes,
	};
}

function isInspectableRecord(value: Inspectable): value is WebGuestInstance {
	return Object.prototype.toString.call(value) === "[object Object]";
}

/** Turn a class method / function into a FunctionExpression source string. */
function callableSource(method: GuestMethod): string {
	const src = Function.prototype.toString.call(method).trim();
	if (
		src.startsWith("function") ||
		src.startsWith("async function") ||
		src.startsWith("(") ||
		src.startsWith("async (")
	) {
		return src;
	}
	// Class method: `greet(name) { … }` → `function greet(name) { … }`
	return `function ${src}`;
}

function kebab(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
		.replace(/_/gu, "-")
		.toLowerCase();
}
