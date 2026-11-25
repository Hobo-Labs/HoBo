import { type ConfigFieldDef, envField } from "./config-schema.js";
import type { ProviderAnnotation } from "./types.js";

/**
 * Dual surface (ADR-0027 + Plan 21):
 *
 * 1. `env({ KEY: value })` — injectable Camp annotation for resources
 *    (not a provider pin; option "env").
 * 2. `env.string()/.boolean()/.int()/.json()` — typed config schema fields.
 */
function envAnnotation(
	config: Readonly<Record<string, string | number | boolean>>,
): ProviderAnnotation {
	const frozen: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(config)) {
		if (key.length === 0) {
			throw new TypeError("env() keys must be non-empty strings");
		}
		frozen[key] = value;
	}
	return Object.freeze({
		provider: "hobo",
		option: "env",
		config: Object.freeze(frozen),
	});
}

type EnvSurface = typeof envAnnotation & {
	string: typeof envField.string;
	boolean: typeof envField.boolean;
	int: typeof envField.int;
	json: typeof envField.json;
};

export const env: EnvSurface = Object.assign(envAnnotation, {
	string: envField.string,
	boolean: envField.boolean,
	int: envField.int,
	json: envField.json,
});

export type { ConfigFieldDef };
