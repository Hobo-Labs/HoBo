/**
 * Pack configuration: one parse boundary, typed accessors afterwards.
 *
 * A raw `JsonObject` handed around a pack implementation is how a
 * port ends up as the string `"5432"` in one place and the number `5432` in
 * another. Here the manifest's `configSchema` is the parser: unknown keys are
 * rejected, required keys must be present, a `secret-ref` key must be an actual
 * `SecretRef` (so a plaintext password cannot be passed as configuration), and
 * a pack that declares `persistence.requirement === "required"` cannot produce a
 * configuration at all without a storage binding for every declared volume.
 */
import { parseSecretRef, type SecretRef } from "@hobo/bindings";

import { PackError } from "./errors.js";
import { isJsonBoolean, isJsonNumber, isJsonString } from "./json.js";
import type { PackConfigField, ParsedPackManifest } from "./manifest.js";

export type PackConfigurationInputValue = string | number | boolean;

export type PackVolumeStorage =
	| { readonly kind: "local-volume"; readonly volumeId: string }
	| { readonly kind: "external-storage"; readonly storageRef: string };

export type PackVolumeBinding = {
	readonly volumeName: string;
	readonly storage: PackVolumeStorage;
};

export type PackConfigurationInput = {
	readonly values: Readonly<Record<string, PackConfigurationInputValue>>;
	readonly volumeBindings?: readonly PackVolumeBinding[];
};

export type PackConfigurationValue =
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "integer"; readonly value: number }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "enum"; readonly value: string }
	| { readonly kind: "secret-ref"; readonly value: SecretRef }
	| { readonly kind: "volume-name"; readonly value: string }
	| { readonly kind: "duration-ms"; readonly value: number };

/**
 * A configuration that has already been checked against its manifest.
 *
 * The accessors throw on a key the schema does not declare, which makes a typo
 * in a pack implementation a loud failure instead of a silent `undefined`.
 */
export type ParsedPackConfiguration = {
	readonly packId: ParsedPackManifest["packId"];
	readonly entries: readonly (readonly [string, PackConfigurationValue])[];
	readonly volumeBindings: readonly PackVolumeBinding[];
	get(key: string): PackConfigurationValue | undefined;
	requireString(key: string): string;
	requireInteger(key: string): number;
	requireBoolean(key: string): boolean;
	requireSecretRef(key: string): SecretRef;
	requireVolumeBinding(volumeName: string): PackVolumeBinding;
};

function configurationInvalid(
	detail: string,
	extra?: Readonly<Record<string, string | number | boolean>>,
): never {
	throw new PackError(
		"PACK_CONFIGURATION_INVALID",
		detail,
		extra !== undefined ? { detail: extra } : {},
	);
}

function parseField(
	field: PackConfigField,
	raw: PackConfigurationInputValue,
): PackConfigurationValue {
	switch (field.kind) {
		case "string":
		case "volume-name": {
			if (!isJsonString(raw) || raw.length === 0) {
				configurationInvalid(
					`configuration ${field.key} must be a non-empty string`,
				);
			}
			return field.kind === "string"
				? { kind: "string", value: raw }
				: { kind: "volume-name", value: raw };
		}
		case "enum": {
			if (!isJsonString(raw) || !(field.enumValues ?? []).includes(raw)) {
				configurationInvalid(
					`configuration ${field.key} must be one of ${(field.enumValues ?? []).join(", ")}`,
				);
			}
			return { kind: "enum", value: raw };
		}
		case "boolean": {
			if (!isJsonBoolean(raw)) {
				configurationInvalid(`configuration ${field.key} must be a boolean`);
			}
			return { kind: "boolean", value: raw };
		}
		case "integer":
		case "duration-ms": {
			if (!isJsonNumber(raw) || !Number.isInteger(raw)) {
				configurationInvalid(`configuration ${field.key} must be an integer`);
			}
			if (field.minimum !== undefined && raw < field.minimum) {
				configurationInvalid(
					`configuration ${field.key} is below its minimum ${field.minimum}`,
				);
			}
			if (field.maximum !== undefined && raw > field.maximum) {
				configurationInvalid(
					`configuration ${field.key} is above its maximum ${field.maximum}`,
				);
			}
			if (field.kind === "duration-ms" && raw < 0) {
				configurationInvalid(
					`configuration ${field.key} must be a non-negative duration`,
				);
			}
			return field.kind === "integer"
				? { kind: "integer", value: raw }
				: { kind: "duration-ms", value: raw };
		}
		case "secret-ref": {
			if (!isJsonString(raw)) {
				configurationInvalid(
					`configuration ${field.key} must be a secret locator string`,
				);
			}
			// `parseSecretRef` rejects credential-shaped input, so a plaintext
			// connection string supplied here fails rather than being stored.
			return { kind: "secret-ref", value: parseSecretRef(raw).ref };
		}
		default: {
			const exhaustive: never = field.kind;
			configurationInvalid(
				`configuration kind ${String(exhaustive)} is not supported`,
			);
		}
	}
}

/**
 * Parse a configuration against its manifest.
 *
 * Storage is checked first: for a pack that requires persistence, an absent
 * volume binding raises `PACK_PERSISTENCE_REQUIRED` rather than defaulting to
 * container-local scratch space that disappears with the container.
 */
export function parsePackConfiguration(
	manifest: ParsedPackManifest,
	input: PackConfigurationInput,
): ParsedPackConfiguration {
	const bindings = input.volumeBindings ?? [];

	if (manifest.persistence.requirement === "required") {
		const byName = new Map(
			bindings.map((binding) => [binding.volumeName, binding]),
		);
		for (const volume of manifest.persistence.volumes) {
			const binding = byName.get(volume.name);
			if (binding === undefined) {
				throw new PackError(
					"PACK_PERSISTENCE_REQUIRED",
					`pack ${manifest.packId} requires durable storage for volume ${volume.name} at ${volume.mountPath}; supply a local volume or an external store instead of relying on a default`,
					{ detail: { volume: volume.name, mountPath: volume.mountPath } },
				);
			}
			if (
				binding.storage.kind === "external-storage" &&
				!volume.externalStorageAllowed
			) {
				throw new PackError(
					"PACK_PERSISTENCE_REQUIRED",
					`volume ${volume.name} declares externalStorageAllowed: false, so it cannot be satisfied by an external store`,
					{ detail: { volume: volume.name } },
				);
			}
			if (
				binding.storage.kind === "local-volume" &&
				binding.storage.volumeId.length === 0
			) {
				configurationInvalid(
					`volume binding for ${volume.name} names no volume id`,
				);
			}
			if (
				binding.storage.kind === "external-storage" &&
				binding.storage.storageRef.length === 0
			) {
				configurationInvalid(
					`volume binding for ${volume.name} names no storage ref`,
				);
			}
		}
		for (const binding of bindings) {
			if (
				!manifest.persistence.volumes.some(
					(volume) => volume.name === binding.volumeName,
				)
			) {
				configurationInvalid(
					`volume binding ${binding.volumeName} does not correspond to any declared volume`,
				);
			}
		}
	} else if (bindings.length > 0) {
		configurationInvalid(
			`pack ${manifest.packId} declares no persistence requirement but a volume binding was supplied`,
		);
	}

	const schema = new Map(
		manifest.configSchema.map((field) => [field.key, field]),
	);
	for (const key of Object.keys(input.values)) {
		if (!schema.has(key)) {
			configurationInvalid(
				`configuration key ${JSON.stringify(key)} is not declared by the pack`,
			);
		}
	}

	const parsed = new Map<string, PackConfigurationValue>();
	for (const field of manifest.configSchema) {
		const raw = Object.hasOwn(input.values, field.key)
			? input.values[field.key]
			: undefined;
		if (raw === undefined) {
			if (field.necessity === "required") {
				configurationInvalid(
					`configuration ${field.key} is required by pack ${manifest.packId}`,
				);
			}
			if (field.defaultValue !== undefined) {
				parsed.set(field.key, parseField(field, field.defaultValue));
			}
			continue;
		}
		parsed.set(field.key, parseField(field, raw));
	}

	const entries = [...parsed.entries()].sort(([a], [b]) => a.localeCompare(b));
	const bindingByName = new Map(
		bindings.map((binding) => [binding.volumeName, binding]),
	);

	const requireKind = <K extends PackConfigurationValue["kind"]>(
		key: string,
		kind: K,
	): Extract<PackConfigurationValue, { kind: K }> => {
		const value = parsed.get(key);
		if (value === undefined) {
			configurationInvalid(`configuration ${key} was not supplied`);
		}
		if (value.kind !== kind) {
			configurationInvalid(
				`configuration ${key} is a ${value.kind}, not a ${kind}`,
			);
		}
		// SAFETY: `return value as Extract<PackConfigurationValue, { kind: K }>;` is required at this I/O or test boundary.
		return value as Extract<PackConfigurationValue, { kind: K }>;
	};

	return {
		packId: manifest.packId,
		entries,
		volumeBindings: [...bindings].sort((a, b) =>
			a.volumeName.localeCompare(b.volumeName),
		),
		get(key) {
			return parsed.get(key);
		},
		requireString(key) {
			const value = parsed.get(key);
			if (value === undefined)
				configurationInvalid(`configuration ${key} was not supplied`);
			if (
				value.kind === "string" ||
				value.kind === "enum" ||
				value.kind === "volume-name"
			) {
				return value.value;
			}
			configurationInvalid(
				`configuration ${key} is a ${value.kind}, not a string`,
			);
		},
		requireInteger(key) {
			const value = parsed.get(key);
			if (value === undefined)
				configurationInvalid(`configuration ${key} was not supplied`);
			if (value.kind === "integer" || value.kind === "duration-ms")
				return value.value;
			configurationInvalid(
				`configuration ${key} is a ${value.kind}, not an integer`,
			);
		},
		requireBoolean(key) {
			return requireKind(key, "boolean").value;
		},
		requireSecretRef(key) {
			return requireKind(key, "secret-ref").value;
		},
		requireVolumeBinding(volumeName) {
			const binding = bindingByName.get(volumeName);
			if (binding === undefined) {
				throw new PackError(
					"PACK_PERSISTENCE_REQUIRED",
					`no storage is bound to volume ${volumeName}`,
					{ detail: { volume: volumeName } },
				);
			}
			return binding;
		},
	};
}
