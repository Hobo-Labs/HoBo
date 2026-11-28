import { CoreParseError } from "./errors.js";
import type { JsonValue } from "./json.js";
import { deepFreeze, nonEmptyString } from "./parse-utils.js";

// public-contract: extension-point id pattern `hobo.<name>/v<major>` (dots/dashes allowed in name).
const EXTENSION_POINT_PATTERN = /^hobo\.[a-z0-9][a-z0-9.-]*\/v[0-9]+$/;

export class ExtensionRegistryError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_EXTENSION_REGISTRY", path, expected, received, message);
		this.name = "ExtensionRegistryError";
	}
}

// domain-view: parse-dont-validate branded extension-point id; wire form
export type ExtensionPointId = string & {
	readonly __brand: "ExtensionPointId";
};

export function parseExtensionPointId(
	value: JsonValue | undefined,
): ExtensionPointId {
	const raw = nonEmptyString(value, "extensionPoint", ExtensionRegistryError);
	if (!EXTENSION_POINT_PATTERN.test(raw)) {
		throw new ExtensionRegistryError(
			"extensionPoint",
			"hobo.<name>/v<major>",
			raw,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return raw as ExtensionPointId;
}

export interface ExtensionRegistryOptions {
	duplicates: "throw" | "replace";
	sealed?: boolean;
}

export interface ExtensionRegistry<T> {
	readonly point: ExtensionPointId;
	readonly sealed: boolean;
	readonly duplicates: "throw" | "replace";
	register(id: string, extension: T): void;
	has(id: string): boolean;
	get(id: string): T | undefined;
	require(id: string): T;
	list(): ReadonlyArray<{ id: string; extension: T }>;
	size(): number;
}

export function createExtensionRegistry<T>(
	point: JsonValue,
	entries: ReadonlyArray<readonly [string, T]> = [],
	options?: ExtensionRegistryOptions,
): ExtensionRegistry<T> {
	const parsedPoint = parseExtensionPointId(point);
	if (options === undefined || options === null) {
		throw new ExtensionRegistryError(
			"options.duplicates",
			'"throw" | "replace" (an explicit duplicate policy is required)',
			options,
		);
	}
	const { duplicates, sealed = false } = options;
	if (duplicates !== "throw" && duplicates !== "replace") {
		throw new ExtensionRegistryError(
			"options.duplicates",
			'"throw" | "replace"',
			duplicates,
		);
	}

	const byId = new Map<string, T>();

	const add = (id: JsonValue, extension: T): void => {
		const parsedId = nonEmptyString(id, "id", ExtensionRegistryError);
		if (byId.has(parsedId) && duplicates === "throw") {
			throw new ExtensionRegistryError(
				`id ${parsedId}`,
				`unique id within ${parsedPoint}`,
				parsedId,
				`duplicate extension id ${parsedId} for ${parsedPoint} (policy: throw)`,
			);
		}
		byId.set(parsedId, extension);
	};

	for (const [id, extension] of entries) {
		add(id, extension);
	}

	return deepFreeze({
		point: parsedPoint,
		sealed,
		duplicates,
		register(id: string, extension: T): void {
			if (sealed) {
				throw new ExtensionRegistryError(
					`id ${String(id)}`,
					"registration before seal",
					id,
					`registry for ${parsedPoint} is sealed; membership is fixed at construction`,
				);
			}
			add(id, extension);
		},
		has: (id: string) => byId.has(id),
		get: (id: string) => byId.get(id),
		require(id: string): T {
			const extension = byId.get(id);
			if (extension === undefined) {
				throw new ExtensionRegistryError(
					`id ${id}`,
					`registered extension for ${parsedPoint}`,
					id,
				);
			}
			return extension;
		},
		list: () =>
			[...byId.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([id, extension]) => ({ id, extension })),
		size: () => byId.size,
	});
}
