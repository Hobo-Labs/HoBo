/**
 * The environment a proxied run starts from. It is built, not inherited:
 * OpenSesame hands its child everything it was started with except the store
 * passphrase and the names a binding overwrites, so whatever this process
 * passes OpenSesame reaches the command. A caller's environment routinely holds
 * credentials (AWS_*, GITHUB_TOKEN, CLOUDFLARE_API_TOKEN, a real VERCEL_TOKEN),
 * and the point of the run is that the command holds only a surrogate. So the
 * environment is an allowlist of what a command needs to run, plus the names the
 * caller lists in `passEnv`, plus the run's own two variables; everything else
 * stays behind.
 *
 * A listed name is the caller's explicit choice and is passed as it is. What is
 * never passed, listed or not, is a credential for a provider this run brokers:
 * if the process already holds one, the run is refused (`real_credential_in_env`)
 * rather than started beside it.
 */

import { ENV_NAME_PATTERN, type ParsedCredentialBinding } from "./binding.js";
import { OpenSesameAdapterError } from "./errors.js";
import { isSurrogate } from "./run-markers.js";
import { type Trust, trustedPath } from "./trust.js";

const nameRe = new RegExp(ENV_NAME_PATTERN, "u");

/** Names a command needs in order to run. */
const INHERITED = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"TERM",
	"TMPDIR",
	"TZ",
	"CI",
	// The launch has already checked it names an absolute path to a file in a trusted place (bridge.ts); OpenSesame reads it, the command has no use for it.
	"OPENSESAME_ENV_PARSE",
	// The Vercel team (or, as the CLI writes VERCEL_ORG_ID, the account) a deploy is in, by hobo's name and the Vercel
	// CLI's (hobo's selectIacProvider reads the first, else the second when it is a team_ id): configuration, not a
	// credential, and named nothing like one (CREDENTIAL_NAME below). Only these names: the rest of VERCEL_* is not a
	// family the allowlist keeps.
	"VERCEL_TEAM_ID",
	"VERCEL_ORG_ID",
] as const;

/** Windows will not start a process without these. */
const INHERITED_WINDOWS = ["SYSTEMROOT", "COMSPEC", "PATHEXT"] as const;

/** Families a command reads for its locale, its Node and its XDG directories, and this project's own settings. */
const INHERITED_PREFIXES = ["LC_", "NODE_", "XDG_", "HOBO_"] as const;

/** A name in one of those families that says it is a credential is left behind. */
const CREDENTIAL_NAME =
	/TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|AUTH/iu;

/**
 * Variables a person or a tool conventionally puts a provider's real token in.
 * A binding names the variable the surrogate goes in; these are the ones a real
 * token would already be in.
 */
const CONVENTIONAL_CREDENTIALS = {
	vercel: ["VERCEL_TOKEN", "VERCEL_API_TOKEN"],
} as const satisfies Readonly<
	Record<ParsedCredentialBinding["provider"], readonly string[]>
>;

export type ChildEnvInput = Readonly<{
	/** The caller's environment. */
	env: NodeJS.ProcessEnv;
	/** Names, beyond the allowlist, the caller passes on as they are. */
	passEnv: readonly string[];
	bindings: readonly ParsedCredentialBinding[];
	platform: NodeJS.Platform;
	/** What a PATH entry is checked against; see `trust.ts`. */
	trust: Trust;
}>;

const INHERITED_NAMES: ReadonlySet<string> = new Set(INHERITED);
const INHERITED_WINDOWS_NAMES: ReadonlySet<string> = new Set(INHERITED_WINDOWS);

function inherits(name: string, platform: NodeJS.Platform): boolean {
	const windows = platform === "win32";
	const key = windows ? name.toUpperCase() : name;
	if (INHERITED_NAMES.has(key)) return true;
	if (windows && INHERITED_WINDOWS_NAMES.has(key)) return true;
	return (
		INHERITED_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
		!CREDENTIAL_NAME.test(key)
	);
}

/** The names a real credential for the bound providers would be in. */
function guarded(bindings: readonly ParsedCredentialBinding[]): string[] {
	const names = new Set<string>();
	for (const binding of bindings) {
		names.add(binding.envName);
		for (const name of CONVENTIONAL_CREDENTIALS[binding.provider])
			names.add(name);
	}
	return [...names];
}

function refuseRealCredentials(input: ChildEnvInput): void {
	for (const name of guarded(input.bindings)) {
		const value = input.env[name];
		if (value !== undefined && value !== "" && !isSurrogate(value)) {
			throw new OpenSesameAdapterError(
				"real_credential_in_env",
				`${name} holds a value that is not an OpenSesame surrogate; this process already has a credential the run exists to keep from the command, so the run is not started. Unset ${name} here: the token belongs in the sealed store only`,
			);
		}
	}
}

function refuseBadPassEnv(passEnv: readonly string[]): void {
	for (const name of passEnv) {
		if (!nameRe.test(name)) {
			throw new OpenSesameAdapterError(
				"launch_invalid",
				"passEnv lists a name that is not an upper-case variable name",
			);
		}
	}
}

function isPathName(name: string, platform: NodeJS.Platform): boolean {
	return platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH";
}

/**
 * The environment OpenSesame is started with; the run's own variables are added by the caller.
 *
 * PATH is always reduced to trusted absolute directories (`trustedPath`), listed
 * in `passEnv` or not: OpenSesame's first act is a bare `node` lookup with the
 * store passphrase in its environment, and an empty or relative entry makes that
 * lookup find whatever sits in the working directory. A name that cannot be an
 * environment variable (empty, with `=` or a NUL) is dropped, not passed.
 */
export function childEnvOf(input: ChildEnvInput): NodeJS.ProcessEnv {
	refuseRealCredentials(input);
	refuseBadPassEnv(input.passEnv);
	const listed = new Set(input.passEnv);
	const out: NodeJS.ProcessEnv = {};
	let pathName: string | undefined;
	for (const [name, value] of Object.entries(input.env)) {
		if (value === undefined) continue;
		if (name === "" || name.includes("=") || name.includes("\0")) continue;
		if (isPathName(name, input.platform)) {
			pathName = name;
			continue;
		}
		if (!listed.has(name) && !inherits(name, input.platform)) continue;
		if (value.includes("\0")) {
			throw new OpenSesameAdapterError(
				"launch_invalid",
				`${name} holds a NUL byte, which cannot be passed to a process`,
			);
		}
		out[name] = value;
	}
	const name = pathName ?? (input.platform === "win32" ? "Path" : "PATH");
	out[name] = trustedPath(
		pathName === undefined ? undefined : input.env[pathName],
		input.trust,
		input.platform,
		input.env,
	);
	return out;
}
