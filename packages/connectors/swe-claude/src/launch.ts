import {
	type AgentSandboxPosture,
	scrubEnvironment,
} from "@hobo/connector-acp";

// Launch configuration for the Claude SWE agent over ACP. Claude's agent
// runtime (the Claude Agent SDK) is bridged to ACP by the VENDOR'S OWN
// adapter binary — `claude-code-acp` (Zed's published bridge over the
// Claude Agent SDK) — which is a stock ACP server on stdio. The HoBo side
// stays shim-free: this file is launch + credential posture only; the
// HOBO-721 connector speaks unmodified ACP to the bridge.

// public-contract: the vendor ACP bridge binary the launch spec spawns.
export const CLAUDE_ACP_COMMAND = "claude-code-acp";
// public-contract: the env var the brokered vendor credential is injected as.
export const CLAUDE_API_KEY_ENV = "ANTHROPIC_API_KEY";
// public-contract: typed gate when no brokered Claude credential is available.
export const CLAUDE_CREDENTIALS_MISSING = "CLAUDE_CREDENTIALS_MISSING";

export class ClaudeCredentialsMissingError extends Error {
	readonly code = CLAUDE_CREDENTIALS_MISSING;
	constructor() {
		super(
			"swe-claude: no brokered Anthropic credential available — wire a credential provider (the Yard broker) or set ANTHROPIC_API_KEY for the live lane.",
		);
		this.name = "ClaudeCredentialsMissingError";
	}
}

// Mints a short-lived vendor credential for one session (the Yard broker
// holds the vendor relationship; the adapter only sees the expiring value).
export type BrokeredClaudeCredential = () => Promise<string>;

export function envClaudeCredential(
	env: Record<string, string | undefined> = process.env,
): BrokeredClaudeCredential {
	return async () => {
		const key = env[CLAUDE_API_KEY_ENV];
		if (!key) {
			throw new ClaudeCredentialsMissingError();
		}
		return key;
	};
}

export interface ClaudeLaunchSpec {
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
export async function buildClaudeLaunch(input: {
	readonly sandbox: AgentSandboxPosture;
	readonly credential: BrokeredClaudeCredential;
}): Promise<ClaudeLaunchSpec> {
	const key = await input.credential();
	return Object.freeze({
		command: CLAUDE_ACP_COMMAND,
		// SAFETY: assertion to `ring[]), env` is required at this boundary.
		args: Object.freeze([] as string[]),
		env: Object.freeze({
			...scrubEnvironment(input.sandbox),
			[CLAUDE_API_KEY_ENV]: key,
		}),
		cwd: input.sandbox.filesystem.root,
	});
}
