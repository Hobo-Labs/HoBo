/**
 * In-memory wasi:config/store provider (ADR-0142).
 * get() returns value-ref + sensitivity only — materialization is host-only.
 */

export type ConfigSensitivity = "public" | "internal" | "sensitive";

export type ConfigValue = Readonly<{
	key: string;
	/** Opaque ref — never plaintext secret material on this wire. */
	"value-ref": string;
	sensitivity: ConfigSensitivity;
}>;

export type ConfigStore = {
	readonly id: string;
	readonly kind: "memory" | "durable";
	readonly wit: "wasi:config/store@0.2.0";
	/** Guest/host shared: ref + sensitivity only. */
	get(key: string): ConfigValue | undefined;
	/** Host-only: put non-secret or ref entries. Sensitive plaintext rejected. */
	put(
		key: string,
		input: {
			readonly valueRef?: string;
			readonly sensitivity?: ConfigSensitivity;
			/** Only allowed when sensitivity is public|internal. */
			readonly value?: string;
		},
	): void;
	/** Host-only materialize of non-sensitive values (never exported to guest WIT). */
	materialize(valueRef: string): string | undefined;
	listKeys(): readonly string[];
	/** True when this provider must be linked (always true when constructed). */
	readonly requiredWhenImported: true;
};

/**
 * Memory config provider for hobo dev / offline Camps.
 * Import-optional: only needed when a component imports wasi:config/store.
 */
export function createMemoryConfigStore(options?: {
	readonly id?: string;
}): ConfigStore {
	const values = new Map<
		string,
		{ valueRef: string; sensitivity: ConfigSensitivity; value?: string }
	>();
	const byRef = new Map<string, string>();

	return {
		id: options?.id ?? "config:memory",
		kind: "memory",
		wit: "wasi:config/store@0.2.0",
		requiredWhenImported: true,
		get(key) {
			const entry = values.get(key);
			if (!entry) return undefined;
			return {
				key,
				"value-ref": entry.valueRef,
				sensitivity: entry.sensitivity,
			};
		},
		put(key, input) {
			const sensitivity = input.sensitivity ?? "public";
			if (sensitivity === "sensitive" && input.value !== undefined) {
				throw Object.assign(
					new Error(
						`config store refuses sensitive plaintext for ${key} — store a value-ref only (ADR-0142)`,
					),
					{ code: "config-sensitive-plaintext-forbidden" },
				);
			}
			const valueRef =
				input.valueRef ??
				(sensitivity === "sensitive" ? `secref://${key}` : `camp://${key}`);
			values.set(key, {
				valueRef,
				sensitivity,
				...(input.value !== undefined && sensitivity !== "sensitive"
					? { value: input.value }
					: undefined),
			});
			if (input.value !== undefined && sensitivity !== "sensitive") {
				byRef.set(valueRef, input.value);
			}
		},
		materialize(valueRef) {
			return byRef.get(valueRef);
		},
		listKeys() {
			return Object.freeze([...values.keys()]);
		},
	};
}

/**
 * Host wiring helper: if a component imports wasi:config, return a store;
 * if not, return undefined (no always-on config service).
 */
export function linkConfigStoreIfImported(input: {
	readonly imports: readonly string[];
	readonly store?: ConfigStore;
}): ConfigStore | undefined {
	const needs = input.imports.some(
		(i) =>
			i === "wasi:config/store" ||
			i.startsWith("wasi:config/store@") ||
			i === "wasi:config",
	);
	if (!needs) return undefined;
	return input.store ?? createMemoryConfigStore();
}
