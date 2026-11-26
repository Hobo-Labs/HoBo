import { isJsonObject, isJsonString } from "../json.js";
import type { ComponentHandle } from "./errors.js";

export function bindingTypesFor(
	handle: ComponentHandle,
): Readonly<Record<string, string>> {
	assertComponent(handle, "bindingTypesFor.handle");
	return Object.fromEntries(
		Object.entries(handle.bindings).map(([alias, binding]) => [
			alias,
			binding.clientType,
		]),
	);
}

function assertComponent<T>(
	handle: T,
	path: string,
): asserts handle is T & ComponentHandle {
	if (
		!isJsonObject(handle) ||
		!isJsonString(handle.kind) ||
		!["service", "container"].includes(handle.kind)
	) {
		throw new Error(`${path}: must be a service or container handle`);
	}
}
