import {
	type ConfigSchema,
	configSensitivity,
	type SecretSourceRank,
} from "./config-types.js";
import { cloneAsJson, type JsonBag, type JsonObject } from "./json.js";
import {
	createContractAssertedDualFixtures,
	type DualIdentityFixtures,
} from "./migration-dual-fixtures.js";
import {
	createLocalStationSecretsPort,
	createMemorySecretsPort,
	type SecretsPort,
} from "./secrets-port.js";

export type DevConfigFixture = Readonly<{
	schemaHash: string;
	campValues: JsonObject;
	secretsPort: SecretsPort;
	boundTokens: Readonly<Record<string, () => Promise<string>>>;
	staticMaterials: Readonly<Record<string, string>>;
	forbidStaticEscape: boolean;
	allowedSources: readonly SecretSourceRank[];
	dualIdentity: DualIdentityFixtures;
}>;

export async function createContractAssertedConfigFixtures(
	schema: ConfigSchema,
	options?: {
		campValues?: JsonObject;
		seedSecrets?: Readonly<Record<string, string>>;
		allowStaticEscape?: boolean;
		tenant?: string;
		residualBackend?: "memory" | "vault-jwt";
		stationId?: string;
	},
): Promise<DevConfigFixture> {
	const residual = options?.residualBackend ?? "memory";
	const stationId = options?.stationId ?? "local";
	const secretsPort: SecretsPort =
		residual === "memory"
			? createMemorySecretsPort({
					id: `secrets:dev-fixture:${schema.schemaHash.slice(0, 16)}`,
				})
			: createLocalStationSecretsPort({
					stationId,
					env: {
						HOBO_LOCAL_SECRETS_BACKEND: residual,
					},
					id: `secrets:dev-fixture:${residual}:${schema.schemaHash.slice(0, 12)}`,
				});
	const seed = options?.seedSecrets ?? {};
	for (const [name, value] of Object.entries(seed)) {
		await secretsPort.put(name, value);
	}

	const campValues: JsonBag = {
		...options?.campValues,
	};
	const boundTokens: Record<string, () => Promise<string>> = {};
	const staticMaterials: Record<string, string> = {};

	for (const [name, field] of Object.entries(schema.fields)) {
		const sensitive = configSensitivity(field) === "sensitive";
		if (sensitive) {
			delete campValues[name];
		} else if (
			(!Object.hasOwn(campValues, name) || campValues[name] === undefined) &&
			field.defaultValue !== undefined
		) {
			Object.defineProperty(campValues, name, {
				value: cloneAsJson(field.defaultValue),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		if (field.source === "bound-resource" && sensitive) {
			Object.defineProperty(boundTokens, name, {
				value: async () =>
					`dev-bound-token:${name}:${schema.schemaHash.slice(7, 15)}`,
				enumerable: true,
			});
		}
		if (
			field.source === "static-escape" &&
			options?.allowStaticEscape === true
		) {
			Object.defineProperty(staticMaterials, name, {
				value: `dev-static-fixture:${name}`,
				enumerable: true,
			});
		}
	}

	const forbidStaticEscape = options?.allowStaticEscape !== true;
	const allowedSources: SecretSourceRank[] = [
		"bound-resource",
		"provider-federation",
		"camp-value",
		...(forbidStaticEscape ? [] : (["static-escape"] as const)),
	];

	const dualIdentity = createContractAssertedDualFixtures({
		tenant: options?.tenant ?? "tenant-dev",
	});

	return Object.freeze({
		schemaHash: schema.schemaHash,
		campValues: Object.freeze(campValues),
		secretsPort,
		boundTokens: Object.freeze(boundTokens),
		staticMaterials: Object.freeze(staticMaterials),
		forbidStaticEscape,
		allowedSources: Object.freeze(allowedSources),
		dualIdentity,
	});
}
