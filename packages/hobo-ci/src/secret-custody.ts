import {
	isForbiddenSecretEnvKey,
	looksLikeSecretEnvValue,
} from "@hobo/bindles";

import type { Env } from "./secret-stores.js";

// Where a HoBo lifecycle may find a secret: the owner's external secret store
// (Infisical, 1Password, Bitwarden), the owner typing it once on the setup
// page, or a workload's own OIDC token. Never the environment: an environment
// variable is inherited by every child process and readable by every process
// of the same user, and it is how a secret ends up in a shell history, a CI
// variable or a `.env` file on disk. Values in hand for a run live in a
// trusted vault (`createTrustedVault`, `@hobo/core`): memory only.
//
// These checks remove known credential names and secret-shaped values before
// launching a child. They are heuristic: an arbitrary secret under an unknown
// name may remain. A strict child environment needs an explicit allowlist.
// The source scan covers the named lifecycle sources and keys only.

/** Variables that hold a sign-in or a credential HoBo's lifecycles use. */
export const SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
	"INFISICAL_TOKEN",
	"INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
	"BWS_ACCESS_TOKEN",
	"BITWARDEN_ACCESS_TOKEN",
	"OP_SERVICE_ACCOUNT_TOKEN",
	"VERCEL_TOKEN",
	"CLOUDFLARE_API_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
	"HOBO_CI_WEBHOOK_SECRET",
	"HOBO_CI_ACCOUNT_TOKEN",
	"HOBO_CD_VERCEL_CLIENT_SECRET",
	"HOBO_CD_VERCEL_TOKEN",
	"HOBO_CD_POSTGRES_URL",
	"PULUMI_ACCESS_TOKEN",
	"PULUMI_CONFIG_PASSPHRASE",
]);

const TOKENISH =
	/(^|_)(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|API_KEY|CREDENTIAL|CREDENTIALS)(_|$)/u;

/** An environment after filtering detected secret names and values. */
export interface PlainEnv {
	[name: string]: string;
}

/** True when a variable matches a known secret name or value pattern. */
export function isSecretEnv(name: string, value: string | undefined): boolean {
	const normalized = name.toUpperCase();
	return (
		SECRET_ENV_NAMES.has(normalized) ||
		normalized.startsWith("HOBO_CD_POSTGRES_URL_") ||
		TOKENISH.test(normalized) ||
		isForbiddenSecretEnvKey(name) ||
		(value !== undefined && looksLikeSecretEnvValue(value))
	);
}

/** Names (never values) of the variables matching a known secret pattern. */
export function secretEnvNames(env: Env): readonly string[] {
	return Object.keys(env)
		.filter((name) => env[name] !== undefined && env[name] !== "")
		.filter((name) => isSecretEnv(name, env[name]))
		.sort();
}

/** Remove detected secrets; unknown names and opaque values may remain. */
export function withoutSecretEnv(env: Env): PlainEnv {
	const kept: PlainEnv = {};
	for (const [name, value] of Object.entries(env))
		if (value !== undefined && !isSecretEnv(name, value)) kept[name] = value;
	return kept;
}

/** One line saying which secrets were ignored, or nothing. */
export function ignoredSecretEnvNotice(env: Env): string | undefined {
	const names = secretEnvNames(env).filter(
		(name) =>
			SECRET_ENV_NAMES.has(name.toUpperCase()) ||
			name.toUpperCase().startsWith("HOBO_CD_POSTGRES_URL"),
	);
	return names.length === 0
		? undefined
		: `Setup ignored these known secret environment variables: ${names.join(", ")}. Keep them in your secret store; sign in on the setup page.`;
}
