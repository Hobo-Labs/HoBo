import {
	type AgentSandboxPosture,
	scrubEnvironment,
} from "@hobo/connector-acp";

// Launch configuration for the Codex SWE agent over ACP. Codex's agent
// runtime (the Codex SDK) is bridged to ACP by the VENDOR'S OWN
// adapter binary — `codex-acp` (Zed's published bridge over the
// Codex SDK) — which is a stock ACP server on stdio. The HoBo side
// stays shim-free: this file is launch + credential posture only; the
// HOBO-721 connector speaks unmodified ACP to the bridge.

// public-contract: the vendor ACP bridge binary the launch spec spawns.
export const CODEX_ACP_COMMAND = "codex-acp";
// public-contract: the env var the brokered vendor credential is injected as.
export const CODEX_API_KEY_ENV = "OPENAI_API_KEY";
// public-contract: typed gate when no brokered Codex credential is available.
export const CODEX_CREDENTIALS_MISSING = "CODEX_CREDENTIALS_MISSING";

export class CodexCredentialsMissingError extends Error {
	readonly code = CODEX_CREDENTIALS_MISSING;
	constructor() {
		super(
			"swe-codex: no brokered OpenAI credential available — wire a credential provider (the Yard broker) or set OPENAI_API_KEY for the live lane.",
		);
		this.name = "CodexCredentialsMissingError";
	}
}

// Mints a short-lived vendor credential for one session (the Yard broker
// holds the vendor relationship; the adapter only sees the expiring value).
export type BrokeredCodexCredential = () => Promise<string>;

export function envCodexCredential(
	env: Record<string, string | undefined> = process.env,
): BrokeredCodexCredential {
	return async () => {
		const key = env[CODEX_API_KEY_ENV];
		if (!key) {
			throw new CodexCredentialsMissingError();
		}
		return key;
	};
}

export interface CodexLaunchSpec {
	readonly command: string;
	readonly args: readonly string[];
	// The FULL subprocess environment: sandbox-scrubbed allowlist entries
	// plus exactly one explicit brokered credential — never ambient creds.
	readonly env: Record<string, string>;
	readonly cwd: string;
}

// Build the launch spec for `connectAcpAgentOverStdio`: the vendor bridge
// command, environment scrubbed to the sandbox allowlist, and the brokered
// credential injected explicitly.
export async function buildCodexLaunch(input: {
	readonly sandbox: AgentSandboxPosture;
	readonly credential: BrokeredCodexCredential;
}): Promise<CodexLaunchSpec> {
	const key = await input.credential();
	return Object.freeze({
		command: CODEX_ACP_COMMAND,
		// SAFETY: assertion to `ring[]), env` is required at this boundary.
		args: Object.freeze([] as string[]),
		env: Object.freeze({
			...scrubEnvironment(input.sandbox),
			[CODEX_API_KEY_ENV]: key,
		}),
		cwd: input.sandbox.filesystem.root,
	});
}
