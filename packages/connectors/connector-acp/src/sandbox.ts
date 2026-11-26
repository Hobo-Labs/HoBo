import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

// The Executor sandbox posture every spawned agent subprocess must run
// under (s3-07 guardrails): NO ambient credentials, workspace-scoped
// filesystem, allowlisted network. Vendor adapters pass this record to the
// spawn; the parse boundary fails closed on anything looser.

// public-contract: the sandbox posture document schema id.
export const SANDBOX_POSTURE_SCHEMA = "hobo.agent-sandbox-posture/v1";

export interface AgentSandboxPosture {
	readonly schema: typeof SANDBOX_POSTURE_SCHEMA;
	readonly ambientCredentials: false;
	readonly filesystem: { readonly scope: "workspace"; readonly root: string };
	readonly network: {
		readonly scope: "allowlist";
		readonly allowlist: readonly string[];
	};
	// Environment variables allowed through to the subprocess (everything
	// else is scrubbed — no inherited cloud credentials).
	readonly envAllowlist: readonly string[];
}

/**
 * Parse-don't-validate boundary for sandbox postures: an untrusted posture
 * document becomes a frozen derived posture or throws. `ambientCredentials`
 * must be exactly `false`; open network scopes are rejected.
 */
export type ProcessEnvBag = { [name: string]: string | undefined };
export type ScrubbedEnv = { [name: string]: string };

export function parseSandboxPosture(input: JsonValue): AgentSandboxPosture {
	if (!isJsonObject(input)) {
		throw new Error("sandbox posture must be an object");
	}
	const source = input;
	if (source.schema !== SANDBOX_POSTURE_SCHEMA) {
		throw new Error(`sandbox posture schema must be ${SANDBOX_POSTURE_SCHEMA}`);
	}
	if (source.ambientCredentials !== false) {
		throw new Error(
			"sandbox posture must set ambientCredentials: false — agents never inherit ambient credentials",
		);
	}
	const filesystem = source.filesystem;
	if (
		!isJsonObject(filesystem) ||
		filesystem.scope !== "workspace" ||
		!isJsonString(filesystem.root) ||
		filesystem.root.length === 0
	) {
		throw new Error(
			"sandbox posture filesystem must be workspace-scoped with a root",
		);
	}
	const network = source.network;
	if (
		!isJsonObject(network) ||
		network.scope !== "allowlist" ||
		!isJsonArray(network.allowlist)
	) {
		throw new Error(
			"sandbox posture network must be allowlist-scoped (no open egress)",
		);
	}
	const envAllowlist = isJsonArray(source.envAllowlist)
		? source.envAllowlist.filter(isJsonString)
		: [];

	return Object.freeze({
		schema: SANDBOX_POSTURE_SCHEMA,
		ambientCredentials: false,
		filesystem: Object.freeze({
			scope: "workspace",
			root: filesystem.root,
		}),
		network: Object.freeze({
			scope: "allowlist",
			allowlist: Object.freeze(network.allowlist.filter(isJsonString)),
		}),
		envAllowlist: Object.freeze(envAllowlist),
	});
}

// Scrub a process environment down to the posture's allowlist — the spawn
// helper applies this so cloud credentials in the parent env never leak
// into the agent subprocess.
export function scrubEnvironment(
	posture: AgentSandboxPosture,
	env: ProcessEnvBag = process.env,
) {
	const pairs: Array<readonly [string, string]> = [];
	for (const key of posture.envAllowlist) {
		const value = env[key];
		if (value !== undefined) {
			pairs.push([key, value]);
		}
	}
	return Object.fromEntries(pairs) satisfies ScrubbedEnv;
}
