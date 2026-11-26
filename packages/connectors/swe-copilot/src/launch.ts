import {
	type AgentSandboxPosture,
	scrubEnvironment,
} from "@hobo/connector-acp";

// Launch configuration for the Copilot SWE agent over ACP. Copilot's agent
// runtime (the Copilot SDK/CLI) is bridged to ACP by the VENDOR'S OWN
// adapter binary — `copilot` (Zed's published bridge over the
// Copilot SDK/CLI) — which is a stock ACP server on stdio. The HoBo side
// stays shim-free: this file is launch + credential posture only; the
// HOBO-721 connector speaks unmodified ACP to the bridge.

// public-contract: the vendor ACP bridge binary the launch spec spawns.
export const COPILOT_ACP_COMMAND = "copilot";
// public-contract: the env var the brokered vendor credential is injected as.
export const COPILOT_API_KEY_ENV = "GH_TOKEN";
// public-contract: typed gate when no brokered Copilot credential is available.
export const COPILOT_CREDENTIALS_MISSING = "COPILOT_CREDENTIALS_MISSING";

export class CopilotCredentialsMissingError extends Error {
	readonly code = COPILOT_CREDENTIALS_MISSING;
	constructor() {
		super(
			"swe-copilot: no brokered GitHub credential available — wire a credential provider (the Yard broker) or set GH_TOKEN for the live lane.",
		);
		this.name = "CopilotCredentialsMissingError";
	}
}

// Mints a short-lived vendor credential for one session (the Yard broker
// holds the vendor relationship; the adapter only sees the expiring value).
export type BrokeredCopilotCredential = () => Promise<string>;

export function envCopilotCredential(
	env: Record<string, string | undefined> = process.env,
): BrokeredCopilotCredential {
	return async () => {
		const key = env[COPILOT_API_KEY_ENV];
		if (!key) {
			throw new CopilotCredentialsMissingError();
		}
		return key;
	};
}

export interface CopilotLaunchSpec {
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
export async function buildCopilotLaunch(input: {
	readonly sandbox: AgentSandboxPosture;
	readonly credential: BrokeredCopilotCredential;
}): Promise<CopilotLaunchSpec> {
	const key = await input.credential();
	return Object.freeze({
		command: COPILOT_ACP_COMMAND,
		// SAFETY: assertion to `] as string[]), env` is required at this boundary.
		args: Object.freeze(["--acp"] as string[]),
		env: Object.freeze({
			...scrubEnvironment(input.sandbox),
			[COPILOT_API_KEY_ENV]: key,
		}),
		cwd: input.sandbox.filesystem.root,
	});
}
