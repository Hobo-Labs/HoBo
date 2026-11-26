import {
	type AgentSandboxPosture,
	scrubEnvironment,
} from "@hobo/connector-acp";

// Launch configuration for the Gemini agent as a STOCK ACP server. Gemini's
// CLI ships native ACP (`gemini --experimental-acp` speaks the protocol on
// stdio), which makes this the thinnest vendor adapter: NO protocol shim,
// no request/response rewriting — the HOBO-721 connector talks to it
// unmodified. Anything this file does is launch + credential posture only.

// public-contract: the vendor agent binary the launch spec spawns.
export const GEMINI_COMMAND = "gemini";
// public-contract: the flag that turns the Gemini CLI into a stock ACP server.
export const GEMINI_ACP_FLAG = "--experimental-acp";
// public-contract: the env var the brokered vendor credential is injected as.
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
// public-contract: typed gate when no brokered Gemini credential is available.
export const GEMINI_CREDENTIALS_MISSING = "GEMINI_CREDENTIALS_MISSING";

export class GeminiCredentialsMissingError extends Error {
	readonly code = GEMINI_CREDENTIALS_MISSING;
	constructor() {
		super(
			"swe-gemini: no brokered Gemini credential available — wire a credential provider (the Yard broker) or set GEMINI_API_KEY for the live lane.",
		);
		this.name = "GeminiCredentialsMissingError";
	}
}

// Mints a short-lived vendor credential for one session (the Yard broker
// holds the vendor relationship; the adapter only sees the expiring value).
export type BrokeredGeminiCredential = () => Promise<string>;

export function envGeminiCredential(
	env: Record<string, string | undefined> = process.env,
): BrokeredGeminiCredential {
	return async () => {
		const key = env[GEMINI_API_KEY_ENV];
		if (!key) {
			throw new GeminiCredentialsMissingError();
		}
		return key;
	};
}

export interface GeminiLaunchSpec {
	readonly command: string;
	readonly args: readonly string[];
	// The FULL subprocess environment: sandbox-scrubbed allowlist entries
	// plus exactly one explicit brokered credential — never ambient creds.
	readonly env: Record<string, string>;
	readonly cwd: string;
}

// Build the launch spec for `connectAcpAgentOverStdio`: stock command +
// flag, environment scrubbed to the sandbox allowlist, and the brokered
// credential injected explicitly.
export async function buildGeminiLaunch(input: {
	readonly sandbox: AgentSandboxPosture;
	readonly credential: BrokeredGeminiCredential;
}): Promise<GeminiLaunchSpec> {
	const key = await input.credential();
	return Object.freeze({
		command: GEMINI_COMMAND,
		args: Object.freeze([GEMINI_ACP_FLAG]),
		env: Object.freeze({
			...scrubEnvironment(input.sandbox),
			[GEMINI_API_KEY_ENV]: key,
		}),
		cwd: input.sandbox.filesystem.root,
	});
}
