/**
 * Contract-asserted config fixtures for `hobo dev` (ADR-0027 + ADR-0070).
 * Same schema contracts as can-deploy; agents only ever see schemaOnlyView.
 * Dual identity fixtures (ADR-0132) are composed in for continuous migration parity.
 *
 * Residual secrets default to **memory** (no optional OpenBao dependency).
 * Install `@hobo/adapter-openbao` when residual OpenBao is required.
 */

import type { ConfigSchema, SecretSourceRank } from "./config-types.js";
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
	/** Schema hash the fixture is asserted against. */
	schemaHash: string;
	campValues: JsonObject;
	/**
	 * Residual secrets port for provider-federation paths.
	 * Default: memory (built-in). OpenBao is optional via @hobo/adapter-openbao.
	 */
	secretsPort: SecretsPort;
	/** Bound-resource token factories (short-lived fixtures). */
	boundTokens: Readonly<Record<string, () => Promise<string>>>;
	/** Static hatch materials only when schema explicitly opts in. */
	staticMaterials: Readonly<Record<string, string>>;
	/** Production-like default: forbid static-escape in local parity mode. */
	forbidStaticEscape: boolean;
	allowedSources: readonly SecretSourceRank[];
	/**
	 * Contract-asserted dual identity fixtures for continuous migration offline
	 * (ADR-0070 + ADR-0132). Fidelity remains `simulated` without real IdPs.
	 */
	dualIdentity: DualIdentityFixtures;
}>;

/**
 * Build contract-asserted fixtures from a Bindle config schema.
 * Sensitive fields never receive plaintext defaults into agent-visible maps.
 */
export async function createContractAssertedConfigFixtures(
	schema: ConfigSchema,
	options?: {
		/** Override non-secret camp values. */
		campValues?: JsonObject;
		/** Pre-seed residual secret names (values stay broker-local). */
		seedSecrets?: Readonly<Record<string, string>>;
		/** Allow static-escape for local hatch testing (default false). */
		allowStaticEscape?: boolean;
		/** Tenant for dual identity fixtures. */
		tenant?: string;
		/**
		 * Residual secrets backend for local Station / hobo dev.
		 * Default **memory** (included). Use vault-jwt for Vault residual.
		 * OpenBao is not built-in — use `@hobo/adapter-openbao`.
		 */
		residualBackend?: "memory" | "vault-jwt";
		/** Station id for residual port scoping. */
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
		if (!field.sensitive && campValues[name] === undefined) {
			if (field.defaultValue !== undefined) {
				campValues[name] = cloneAsJson(field.defaultValue);
			}
		}
		if (field.source === "bound-resource" && field.sensitive) {
			boundTokens[name] = async () =>
				`dev-bound-token:${name}:${schema.schemaHash.slice(7, 15)}`;
		}
		if (
			field.source === "static-escape" &&
			options?.allowStaticEscape === true
		) {
			staticMaterials[name] = `dev-static-fixture:${name}`;
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
