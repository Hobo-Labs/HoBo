import {
	type AgentSandboxPosture,
	scrubEnvironment,
} from "@hobo/connector-acp";

// Launch configuration for the Grok SWE agent over ACP. Grok's agent
// runtime (the xAI Grok SDK) is bridged to ACP by the VENDOR'S OWN
// adapter binary — `grok-acp` (Zed's published bridge over the
// xAI Grok SDK) — which is a stock ACP server on stdio. The HoBo side
// stays shim-free: this file is launch + credential posture only; the
// HOBO-721 connector speaks unmodified ACP to the bridge.

// public-contract: the vendor ACP bridge binary the launch spec spawns.
export const GROK_ACP_COMMAND = "grok-acp";
// public-contract: the env var the brokered vendor credential is injected as.
export const GROK_API_KEY_ENV = "XAI_API_KEY";
// public-contract: typed gate when no brokered Grok credential is available.
export const GROK_CREDENTIALS_MISSING = "GROK_CREDENTIALS_MISSING";

export class GrokCredentialsMissingError extends Error {
	readonly code = GROK_CREDENTIALS_MISSING;
	constructor() {
		super(
			"swe-grok: no brokered xAI credential available — wire a credential provider (the Yard broker) or set XAI_API_KEY for the live lane.",
		);
		this.name = "GrokCredentialsMissingError";
	}
}

// Mints a short-lived vendor credential for one session (the Yard broker
// holds the vendor relationship; the adapter only sees the expiring value).
export type BrokeredGrokCredential = () => Promise<string>;

export function envGrokCredential(
	env: Record<string, string | undefined> = process.env,
): BrokeredGrokCredential {
	return async () => {
		const key = env[GROK_API_KEY_ENV];
		if (!key) {
			throw new GrokCredentialsMissingError();
		}
		return key;
	};
}

export interface GrokLaunchSpec {
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
export async function buildGrokLaunch(input: {
	readonly sandbox: AgentSandboxPosture;
	readonly credential: BrokeredGrokCredential;
}): Promise<GrokLaunchSpec> {
	const key = await input.credential();
	return Object.freeze({
		command: GROK_ACP_COMMAND,
		// SAFETY: assertion to `ring[]), env` is required at this boundary.
		args: Object.freeze([] as string[]),
		env: Object.freeze({
			...scrubEnvironment(input.sandbox),
			[GROK_API_KEY_ENV]: key,
		}),
		cwd: input.sandbox.filesystem.root,
	});
}
