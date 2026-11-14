import {
	isForbiddenSecretEnvKey,
	looksLikeSecretEnvValue,
} from "@hobo/bindles";
import type { TrustedVault } from "@hobo/core";

import type { Env } from "./secret-stores.js";

// Where a HoBo lifecycle may find a secret: the owner's external secret store
// (Infisical, 1Password, Bitwarden), the owner typing it once on the setup
// page, or a workload's own OIDC token. Never the environment: an environment
// variable is inherited by every child process and readable by every process
// of the same user, and it is how a secret ends up in a shell history, a CI
// variable or a `.env` file on disk. Values in hand for a run live in a
// trusted vault (`createTrustedVault`, `@hobo/core`): memory only.
//
// Setup settings filter known credential names and secret-shaped values. That
// filter is heuristic: an arbitrary secret under an unknown name may remain.
// The browser opener instead receives only the names its platform needs.
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

/**
 * A run owns its vault until clear. A late callback cannot put credentials
 * back after that boundary, even if its request outlives the setup page.
 */
export function scopeRunVault(vault: TrustedVault): TrustedVault {
	let ended = false;
	return {
		put(name, value) {
			if (ended) throw new Error("credential run has ended");
			vault.put(name, value);
		},
		has: (name) => !ended && vault.has(name),
		reveal: (name) => (ended ? undefined : vault.reveal(name)),
		drop: (name) => {
			if (!ended) vault.drop(name);
		},
		names: () => (ended ? [] : vault.names()),
		clear: () => {
			if (!ended) {
				ended = true;
				vault.clear();
			}
		},
	};
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

// The platform opener needs desktop/session discovery and ordinary process
// locations. Do not forward arbitrary application variables or loader hooks.
const BROWSER_ENV_NAMES: ReadonlySet<string> = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CONFIG_DIRS",
	"XDG_DATA_DIRS",
	"XDG_CURRENT_DESKTOP",
	"XDG_SESSION_DESKTOP",
	"XDG_SESSION_TYPE",
	"DESKTOP_SESSION",
	"DBUS_SESSION_BUS_ADDRESS",
	"SYSTEMROOT",
	"WINDIR",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
	"TMPDIR",
]);

/** An allowlisted desktop environment for the browser opener, with no loader hooks. */
export function browserEnvironment(env: Env): PlainEnv {
	const kept: PlainEnv = {};
	for (const [name, value] of Object.entries(env)) {
		const lookup = process.platform === "win32" ? name.toUpperCase() : name;
		if (
			value !== undefined &&
			BROWSER_ENV_NAMES.has(lookup) &&
			!isSecretEnv(name, value)
		)
			kept[name] = value;
	}
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
