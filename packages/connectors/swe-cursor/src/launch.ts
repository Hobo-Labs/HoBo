import {
	type AgentSandboxPosture,
	scrubEnvironment,
} from "@hobo/connector-acp";

// Launch configuration for the Cursor SWE agent over ACP. Cursor's agent
// runtime (the Cursor SDK / cursor-agent) is bridged to ACP by the VENDOR'S OWN
// adapter binary — `cursor-agent-acp` (Zed's published bridge over the
// Cursor SDK / cursor-agent) — which is a stock ACP server on stdio. The HoBo side
// stays shim-free: this file is launch + credential posture only; the
// HOBO-721 connector speaks unmodified ACP to the bridge.

// public-contract: the vendor ACP bridge binary the launch spec spawns.
export const CURSOR_ACP_COMMAND = "cursor-agent-acp";
// public-contract: the env var the brokered vendor credential is injected as.
export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";
// public-contract: typed gate when no brokered Cursor credential is available.
export const CURSOR_CREDENTIALS_MISSING = "CURSOR_CREDENTIALS_MISSING";

export class CursorCredentialsMissingError extends Error {
	readonly code = CURSOR_CREDENTIALS_MISSING;
	constructor() {
		super(
			"swe-cursor: no brokered Cursor credential available — wire a credential provider (the Yard broker) or set CURSOR_API_KEY for the live lane.",
		);
		this.name = "CursorCredentialsMissingError";
	}
}

// Mints a short-lived vendor credential for one session (the Yard broker
// holds the vendor relationship; the adapter only sees the expiring value).
export type BrokeredCursorCredential = () => Promise<string>;

export function envCursorCredential(
	env: Record<string, string | undefined> = process.env,
): BrokeredCursorCredential {
	return async () => {
		const key = env[CURSOR_API_KEY_ENV];
		if (!key) {
			throw new CursorCredentialsMissingError();
		}
		return key;
	};
}

export interface CursorLaunchSpec {
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
export async function buildCursorLaunch(input: {
	readonly sandbox: AgentSandboxPosture;
	readonly credential: BrokeredCursorCredential;
}): Promise<CursorLaunchSpec> {
	const key = await input.credential();
	return Object.freeze({
		command: CURSOR_ACP_COMMAND,
		// SAFETY: assertion to `ring[]), env` is required at this boundary.
		args: Object.freeze([] as string[]),
		env: Object.freeze({
			...scrubEnvironment(input.sandbox),
			[CURSOR_API_KEY_ENV]: key,
		}),
		cwd: input.sandbox.filesystem.root,
	});
}
