import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";
import type { BindleDefinition } from "./types.js";
import type { ManifestV1 } from "./manifest/manifest.js";

export type BindingDeliveryReason = Readonly<{
	code:
		| "connection-strings-env"
		| "secret-env-key"
		| "secret-env-value"
		| "secret-connection-string"
		| "connection-string-token-env";
	path?: string;
	message: string;
}>;

export type BindingDeliveryGateResult = Readonly<{
	ok: boolean;
	dimension: "binding-delivery";
	reasons: readonly BindingDeliveryReason[];
	summary: string;
}>;

const SECRET_KEY_RE =
	/^(ConnectionStrings__.*|DATABASE_URL|REDIS_URL|MONGO_URL|MYSQL_URL|PGPASSWORD|API_KEY|PASSWORD|SECRET|TOKEN|AUTHORIZATION|PRIVATE_KEY|.*_PASSWORD|.*_SECRET|.*_SECRET_.*|.*_TOKEN|.*_CREDENTIALS?|.*_PRIVATE_KEY|.*_API_KEY)$/i;

const USERINFO_URI_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i;
const CONNECTION_REFERENCE_RE = /^\{[A-Za-z][A-Za-z0-9_-]*\.connectionString\}$/;

export function isForbiddenSecretEnvKey(key: string): boolean {
	return SECRET_KEY_RE.test(key);
}

export function looksLikeSecretEnvValue(value: string): boolean {
	if (USERINFO_URI_RE.test(value)) return true;
	if (/\{[^}]+\.connectionString\}/.test(value)) return true;
	if (/password\s*=/i.test(value)) return true;
	if (/^\s*Bearer\s+\S+/i.test(value)) return true;
	if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value)) return true;
	try {
		const url = new URL(value);
		for (const key of url.searchParams.keys()) {
			if (
				isForbiddenSecretEnvKey(key.replaceAll("-", "_")) ||
				/^(?:sig|signature|x-amz-signature|x-goog-signature)$/i.test(key)
			) return true;
		}
	} catch {
		return false;
	}
	return false;
}

export function evaluateBindingDeliveryGate(input: {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly manifest?: ManifestV1;
	readonly definition?: BindleDefinition;
	readonly resourceEnvs?: Readonly<
		Record<string, Readonly<Record<string, string>> | undefined>
	>;
}): BindingDeliveryGateResult {
	const reasons: BindingDeliveryReason[] = [];

	const checkMap = (
		env: Readonly<Record<string, string | undefined>>,
		pathPrefix: string,
	) => {
		for (const [key, raw] of Object.entries(env)) {
			const value = raw ?? "";
			if (/^ConnectionStrings__/i.test(key)) {
				reasons.push({
					code: "connection-strings-env",
					path: `${pathPrefix}.${key}`,
					message: `forbidden ConnectionStrings__* env ${key} — use WIT links / ctx.bindings (ADR-0141)`,
				});
				continue;
			}
			if (isForbiddenSecretEnvKey(key)) {
				reasons.push({
					code: "secret-env-key",
					path: `${pathPrefix}.${key}`,
					message: `forbidden secret-shaped env key ${key}`,
				});
			}
			if (isJsonString(value) && looksLikeSecretEnvValue(value)) {
				reasons.push({
					code: /connectionString/i.test(value)
						? "connection-string-token-env"
						: "secret-env-value",
					path: `${pathPrefix}.${key}`,
					message: `forbidden secret-shaped env value at ${key}`,
				});
			}
		}
	};

	const checkAnnotationValues = (values: JsonObject, pathPrefix: string) => {
		const entries: Array<[string, string]> = [];
		for (const [key, value] of Object.entries(values)) {
			if (isJsonString(value) || isJsonNumber(value) || isJsonBoolean(value)) {
				entries.push([key, String(value)]);
			}
		}
		checkMap(Object.fromEntries(entries), pathPrefix);
	};

	const checkConnectionString = (value: string, path: string, id: string) => {
		if (!CONNECTION_REFERENCE_RE.test(value) && looksLikeSecretEnvValue(value)) {
			reasons.push({
				code: "secret-connection-string",
				path,
				message: `forbidden credential-bearing connection string for resource ${id}`,
			});
		}
	};

	if (input.definition) {
		for (const [id, resource] of Object.entries(input.definition.resources)) {
			for (const annotation of resource.annotations) {
				const path = `resources.${id}.annotations.${annotation.option}`;
				if (annotation.option === "env") {
					checkAnnotationValues(annotation.config, path);
				}
				if (annotation.option !== "dependency") continue;
				const { env, endpoints, connectionString } = annotation.config;
				if (env && isJsonObject(env)) {
					checkAnnotationValues(env, `${path}.env`);
				}
				if (endpoints && isJsonObject(endpoints)) {
					checkAnnotationValues(endpoints, `${path}.endpoints`);
				}
				if (isJsonString(connectionString)) {
					checkConnectionString(connectionString, `${path}.connectionString`, id);
				}
			}
		}
	}

	if (input.env) {
		checkMap(input.env, "env");
	}
	if (input.resourceEnvs) {
		for (const [id, env] of Object.entries(input.resourceEnvs)) {
			if (env) checkMap(env, `resources.${id}.env`);
		}
	}

	if (input.manifest) {
		for (const [id, resource] of Object.entries(
			input.manifest.value.resources,
		)) {
			if (resource.env) checkMap(resource.env, `resources.${id}.env`);
			if (resource.connectionString) {
				checkConnectionString(
					resource.connectionString,
					`resources.${id}.connectionString`,
					id,
				);
			}
		}
	}

	const ok = reasons.length === 0;
	return {
		ok,
		dimension: "binding-delivery",
		reasons,
		summary: ok
			? "binding-delivery: links-only (no secret-shaped env)"
			: `blocked: ${reasons.length} binding-delivery violation(s)`,
	};
}
