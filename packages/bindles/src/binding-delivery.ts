/**
 * Binding-delivery integrity gate (ADR-0141).
 * Forbidden: secret-shaped process env as a substitute for WIT links.
 */

import { isJsonString } from "./json.js";

export type BindingDeliveryReason = Readonly<{
	code:
		| "connection-strings-env"
		| "secret-env-key"
		| "secret-env-value"
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

/** Credential-shaped keys only — avoid false positives on HOBO_* platform env. */
const SECRET_KEY_RE =
	/^(ConnectionStrings__|DATABASE_URL|REDIS_URL|MONGO_URL|MYSQL_URL|PGPASSWORD|API_KEY|.*_PASSWORD|.*_SECRET|.*_API_KEY)$/i;

const USERINFO_URI_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^@/\s]+@/i;

/** True when an env key is reserved for credential bags (forbidden on default paths). */
export function isForbiddenSecretEnvKey(key: string): boolean {
	return key.startsWith("ConnectionStrings__") || SECRET_KEY_RE.test(key);
}

/** True when a value looks like embedded credentials or ambient connection-string grants. */
export function looksLikeSecretEnvValue(value: string): boolean {
	if (USERINFO_URI_RE.test(value)) return true;
	if (/\{[^}]+\.connectionString\}/.test(value)) return true;
	if (/password=/i.test(value) && /[;:]/.test(value)) return true;
	return false;
}

/**
 * Fail-closed gate: resource access must use links/bindings, not secret env.
 */
export function evaluateBindingDeliveryGate(input: {
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Manifest-style resource env maps keyed by resource id. */
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
			if (key.startsWith("ConnectionStrings__")) {
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
