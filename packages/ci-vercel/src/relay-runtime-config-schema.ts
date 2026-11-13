/**
 * The hosted relay's runtime configuration, as the config-service loader
 * parses it. Its record is `RelayRuntimeConfig` in `data-models/relay_runtime_config.proto`,
 * whose JSON names are these keys, with CUE constraints in
 * `data-models/relay-runtime-config/relay_runtime_config.cue`.
 */

import { createHash, createPrivateKey } from "node:crypto";
import { parseFleetReporters } from "@hobo/ci-gh-actions";
import { z } from "zod";

const canonicalKey = z
	.string()
	.regex(/^[A-Za-z0-9_-]{43}$/)
	.refine((value) => {
		const bytes = Buffer.from(value, "base64url");
		return bytes.length === 32 && bytes.toString("base64url") === value;
	});
const origin = z
	.string()
	.url()
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				url.origin === value &&
				!url.username &&
				!url.password
			);
		} catch {
			return false;
		}
	});

/** Configuration owned by HoBo; platform credentials stay out. */
const hoboSettings = {
	HOBO_CI_PUBLIC_URL: origin,
	HOBO_CI_SESSION_KEY: canonicalKey,
	HOBO_CI_BOOTSTRAP_ACCOUNT_ID: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
	HOBO_CI_BOOTSTRAP_TOKEN_SHA256: z.string().regex(/^[a-f0-9]{64}$/),
	HOBO_CI_INVITATION_EXPIRES_AT: z
		.string()
		.regex(/^\d{13}$/)
		.optional(),
	HOBO_CI_CONTROL_TOKENS_JSON: z.string().min(2).max(24_576),
	HOBO_CI_ONBOARDING_CONTROL_TOKEN: canonicalKey.optional(),
	HOBO_CI_CONFIG_JSON: z.string().min(2).max(24_576),
	CRON_SECRET: z.string().min(32).max(1024),
	HOBO_CI_SANDBOX_ENABLED: z.literal("1").optional(),
	HOBO_CI_SANDBOX_TEAM_ID: z
		.string()
		.regex(/^team_[A-Za-z0-9]{1,100}$/)
		.optional(),
	HOBO_CI_SANDBOX_PROJECT_ID: z
		.string()
		.regex(/^prj_[A-Za-z0-9]{1,100}$/)
		.optional(),
	HOBO_CI_SANDBOX_ISSUER: z.string().url().max(256).optional(),
	HOBO_CI_SANDBOX_PLAN: z.enum(["hobby", "pro", "enterprise"]).optional(),
	HOBO_CI_SANDBOX_DOMAINS_JSON: z.string().min(2).max(16_384).optional(),
};
const hoboFields = z.object(hoboSettings);

function rsaKey(value: string): boolean {
	try {
		const key = createPrivateKey(value);
		return (
			key.asymmetricKeyType === "rsa" &&
			(key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048
		);
	} catch {
		return false;
	}
}

/** The GitHub App's identity and credentials, as `hobo ci app create` deposits them. */
const appSettings = {
	HOBO_CI_GITHUB_APP_ID: z.string().regex(/^[1-9]\d{0,15}$/),
	HOBO_CI_GITHUB_APP_PRIVATE_KEY: z.string().max(32_768).refine(rsaKey, {
		message: "expected an RSA private key of 2048 bits or more",
	}),
	HOBO_CI_WEBHOOK_SECRET: z
		.string()
		.max(1024)
		.refine((value) => Buffer.byteLength(value) >= 32, {
			message: "expected 32 bytes or more",
		}),
	HOBO_CI_GITHUB_APP_CLIENT_ID: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
	HOBO_CI_GITHUB_APP_CLIENT_SECRET: z.string().regex(/^[!-~]{20,256}$/),
};

/**
 * Secrets of the relay itself. The Sandbox proxy token key: each proxy session token is derived
 * from it (an HMAC of the lease id), so no token is stored anywhere.
 */
const relaySecrets = {
	HOBO_CI_SANDBOX_PROXY_TOKEN_KEY: canonicalKey.optional(),
};

/**
 * Cache bindings and offers the config service may hold (ADR-0179 phase 4c):
 * a backend's connection the Marketplace does not inject (an Aiven Valkey URL
 * is the expected one), and the declared offers and switch marks. Each value
 * is checked for shape only; it reaches the cache's client and nothing else,
 * and every error names the key.
 */
const cacheSettings = {
	VALKEY_URL: z
		.string()
		.max(2048)
		.regex(/^rediss?:\/\/[^\s]+$/u)
		.optional(),
	TURSO_DATABASE_URL: z
		.string()
		.max(2048)
		.regex(/^(?:libsql|https):\/\/[^\s@]+$/u)
		.optional(),
	TURSO_AUTH_TOKEN: z
		.string()
		.regex(/^[!-~]{1,4096}$/u)
		.optional(),
	BLOB_STORE_ID: z
		.string()
		.regex(/^(?:store_)?[A-Za-z0-9]{1,64}$/u)
		.optional(),
	HOBO_CI_CACHE_OFFERS_JSON: z.string().min(2).max(16_384).optional(),
};

/**
 * Fleet verdicts (ADR-0180): who may report (public keys only, parsed whole
 * by the record's own parser), the kill switch, and the daily allowance.
 */
const fleetVerdictSettings = {
	HOBO_CI_FLEET_REPORTERS_JSON: z
		.string()
		.min(2)
		.max(16_384)
		.refine((value) => parseFleetReporters(value) !== undefined, {
			message: "expected a fleet reporter enrollment",
		})
		.optional(),
	HOBO_CI_FLEET_VERDICT_SERVING: z.enum(["on", "off"]).optional(),
	HOBO_CI_FLEET_VERDICT_DAILY_BLOCK_MINUTES: z
		.string()
		.regex(/^[1-9]\d{0,3}$/u)
		.refine((value) => Number(value) <= 1440, {
			message: "expected at most a day",
		})
		.optional(),
};

/** The onboarding token must be one of the owner's control tokens. */
function onboardingBinding(
	value: z.infer<typeof hoboFields>,
	context: z.RefinementCtx,
): void {
	if (!value.HOBO_CI_ONBOARDING_CONTROL_TOKEN) return;
	const digest = createHash("sha256")
		.update(value.HOBO_CI_ONBOARDING_CONTROL_TOKEN)
		.digest("hex");
	try {
		const parsed = z
			.object({
				tokens: z.array(
					z
						.object({
							accountId: z.string(),
							tokenSha256: z.string(),
							scopes: z.array(z.string()),
						})
						.passthrough(),
				),
			})
			.parse(JSON.parse(value.HOBO_CI_CONTROL_TOKENS_JSON));
		if (
			parsed.tokens.some(
				(credential) =>
					credential.accountId === value.HOBO_CI_BOOTSTRAP_ACCOUNT_ID &&
					credential.tokenSha256 === digest &&
					["policy:read", "policy:write", "repositories:write"].every((scope) =>
						credential.scopes.includes(scope),
					),
			)
		)
			return;
	} catch {
		// Never expose the control-token configuration in a parse error.
	}
	context.addIssue({
		code: "custom",
		message: "invalid onboarding control binding",
	});
}

/** Each setting the config service holds for the relay, with its parser. */
export const RELAY_RUNTIME_CONFIG_SETTINGS = Object.freeze({
	...hoboSettings,
	...appSettings,
	...relaySecrets,
	...cacheSettings,
	...fleetVerdictSettings,
});

/** The relay's whole runtime configuration as the config service holds it. */
export const RelayRuntimeConfigSchema = z
	.object(RELAY_RUNTIME_CONFIG_SETTINGS)
	.strict()
	.superRefine(onboardingBinding);

/** Every key the config service may hold for the relay, and nothing else. */
export const RELAY_RUNTIME_CONFIG_KEYS: readonly string[] = Object.freeze(
	Object.keys(RELAY_RUNTIME_CONFIG_SETTINGS),
);
