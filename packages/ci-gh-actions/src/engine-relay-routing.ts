import type { z } from "zod";
import type { CiProjectEnvironment } from "./project-config.js";
import {
	EnvironmentEngineRelaysSchema,
	EnvironmentEnginesSchema,
} from "./project-config.js";
import {
	DEFAULT_CI_ENGINE_ID,
	isKnownCiEngineId,
	normalizeCiEngineSelection,
} from "./ci-engine-inventory.js";

export interface CiEngineRelayOverride {
	readonly relayOrigin?: string;
}

export function parseEnvironmentEngineList(
	raw: z.input<typeof EnvironmentEnginesSchema> | undefined,
): readonly string[] | undefined {
	if (raw === undefined) return undefined;
	if (Array.isArray(raw)) {
		const engines = [...raw];
		for (const engine of engines) {
			if (!isKnownCiEngineId(engine)) throw new Error("invalid engine list");
		}
		return Object.freeze(engines);
	}
	const engines = Object.keys(raw);
	for (const engine of engines) {
		if (!isKnownCiEngineId(engine)) throw new Error("invalid engine list");
	}
	return Object.freeze([...engines]);
}

export function parseEnvironmentEngineRelays(
	raw: z.input<typeof EnvironmentEngineRelaysSchema> | undefined,
): Readonly<Record<string, CiEngineRelayOverride>> | undefined {
	if (raw === undefined) return undefined;
	const parsed = EnvironmentEngineRelaysSchema.parse(raw);
	const result: Record<string, CiEngineRelayOverride> = {};
	for (const [engine, value] of Object.entries(parsed)) {
		if (!isKnownCiEngineId(engine)) throw new Error("invalid engine relay override");
		const relayOrigin = value.relayOrigin;
		if (relayOrigin !== undefined) {
			result[engine] = Object.freeze({ relayOrigin });
		} else {
			result[engine] = Object.freeze({});
		}
	}
	return Object.freeze(result);
}

export function resolveEnvironmentEngines(options: {
	readonly environment: Pick<
		CiProjectEnvironment,
		"engines" | "engineRelays"
	>;
	readonly inventory: readonly string[];
	readonly cliEngines?: readonly string[] | undefined;
}): readonly string[] {
	const { inventory, environment, cliEngines } = options;
	if (environment.engines && cliEngines && cliEngines.length > 0) {
		return normalizeCiEngineSelection({
			inventory,
			configured: environment.engines,
			cli: cliEngines,
		});
	}
	if (environment.engines) {
		return normalizeCiEngineSelection({
			inventory,
			configured: environment.engines,
		});
	}
	if (cliEngines && cliEngines.length > 0) {
		return normalizeCiEngineSelection({ inventory, cli: cliEngines });
	}
	return normalizeCiEngineSelection({ inventory });
}

export function resolveEngineRelayOrigin(
	environment: Pick<
		CiProjectEnvironment,
		"relayOrigin" | "engineRelays" | "allowInsecureLoopback"
	>,
	engineId: string,
): string {
	const override = environment.engineRelays?.[engineId]?.relayOrigin;
	return override ?? environment.relayOrigin;
}

export function collectAllowedRelayOrigins(
	environment: Pick<
		CiProjectEnvironment,
		"relayOrigin" | "engineRelays"
	>,
): readonly string[] {
	const origins = new Set<string>([environment.relayOrigin]);
	for (const override of Object.values(environment.engineRelays ?? {}))
		if (override.relayOrigin) origins.add(override.relayOrigin);
	return Object.freeze([...origins]);
}

export function defaultCiWebhookEngine(): string {
	return DEFAULT_CI_ENGINE_ID;
}
