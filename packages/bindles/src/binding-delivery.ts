import { isJsonString } from "./json.js";
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
	/^(ConnectionStrings__.*|DATABASE_URL|REDIS_URL|MONGO_URL|MYSQL_URL|PGPASSWORD|API_KEY|PASSWORD|SECRET|TOKEN|PRIVATE_KEY|.*_PASSWORD|.*_SECRET|.*_API_KEY|.*_TOKEN|.*_PRIVATE_KEY)$/i;

const USERINFO_URI_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i;

export function isForbiddenSecretEnvKey(key: string): boolean {
	return SECRET_KEY_RE.test(key);
}

export function looksLikeSecretEnvValue(value: string): boolean {
	if (USERINFO_URI_RE.test(value)) return true;
	if (/\{[^}]+\.connectionString\}/.test(value)) return true;
	if (/password\s*=/i.test(value) && /[;:]/.test(value)) return true;
	if (/(?:^|[\s;?&])(?:password|pwd)\s*=/i.test(value)) return true;
	return false;
}

export function evaluateBindingDeliveryGate(input: {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly manifest?: ManifestV1;
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
			if (
				resource.connectionString &&
				looksLikeSecretEnvValue(resource.connectionString)
			) {
				reasons.push({
					code: "secret-connection-string",
					path: `resources.${id}.connectionString`,
					message: `forbidden credential-bearing connection string for resource ${id}`,
				});
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
