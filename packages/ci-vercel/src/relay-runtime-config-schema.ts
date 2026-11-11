/**
 * The hosted relay's runtime configuration: one schema, used by the Neon
 * broker (until phase 7 removes it) and by the config-service loader. Its
 * record is `RelayRuntimeConfig` in `data-models/relay_runtime_config.proto`,
 * whose JSON names are these keys, with CUE constraints in
 * `data-models/relay-runtime-config/relay_runtime_config.cue`.
 */

import { createHash, createPrivateKey } from "node:crypto";
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

/** Configuration owned by HoBo; database and platform credentials stay out. */
const brokerSettings = {
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
const brokerFields = z.object(brokerSettings);

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

/** The onboarding token must be one of the owner's control tokens. */
function onboardingBinding(
	value: z.infer<typeof brokerFields>,
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

/** Only configuration owned by HoBo may cross the Neon broker boundary. */
export const RuntimeBrokerConfig = brokerFields
	.strict()
	.superRefine(onboardingBinding);
export type RuntimeBrokerConfig = z.infer<typeof RuntimeBrokerConfig>;

/** Each setting the config service holds for the relay, with its parser. */
export const RELAY_RUNTIME_CONFIG_SETTINGS = Object.freeze({
	...brokerSettings,
	...appSettings,
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
