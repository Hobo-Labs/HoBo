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
// This module is the enforcement. `secretEnvNames` names the variables in an
// environment that hold a secret, so a lifecycle can say it ignored them;
// `withoutSecretEnv` is the environment a child process gets; and
// `test/secret-custody.test.ts` scans the lifecycle sources so that none of
// them reads one of these variables again.

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
	/(^|_)(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|API_KEY)(_|$)/u;

/** An environment with every secret taken out: what a child process gets. */
export interface PlainEnv {
	[name: string]: string;
}

/** True when a variable of this name (or value) carries a secret. */
export function isSecretEnv(name: string, value: string | undefined): boolean {
	return (
		SECRET_ENV_NAMES.has(name) ||
		name.startsWith("HOBO_CD_POSTGRES_URL_") ||
		TOKENISH.test(name) ||
		isForbiddenSecretEnvKey(name) ||
		(value !== undefined && looksLikeSecretEnvValue(value))
	);
}

/** Names (never values) of the variables in `env` that hold a secret. */
export function secretEnvNames(env: Env): readonly string[] {
	return Object.keys(env)
		.filter((name) => env[name] !== undefined && env[name] !== "")
		.filter((name) => isSecretEnv(name, env[name]))
		.sort();
}

/** The environment a child process gets: the same, minus every secret. */
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
			SECRET_ENV_NAMES.has(name) || name.startsWith("HOBO_CD_POSTGRES_URL"),
	);
	return names.length === 0
		? undefined
		: `HoBo does not read secrets from the environment; ignored ${names.join(", ")}. Keep them in your secret store; HoBo signs in to it on the setup page.`;
}
