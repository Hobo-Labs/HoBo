import {
	BITWARDEN_API_KEY_CAPTURES,
	GITHUB_APP_CODE_CAPTURE,
	INFISICAL_CLI_SESSION_CAPTURE,
	ONE_PASSWORD_SIGN_IN_CAPTURES,
	type OwnerChannel,
} from "@hobo/hobo-ci";
import { type ParsedSecretCaptureSpec, secretCaptureSpec } from "@hobo/mcp";

/**
 * The owner channel of a ceremony run through the HoBo MCP server (an agent
 * on a remote dev box). The server lives across the agent's tool calls, so a
 * run that needs the owner refuses with what to do (the link to open, the
 * value to hand over), the agent shows the owner the link and the secret
 * capture form, and the value the owner submits waits here, in this
 * process's memory, until the next run takes it. It never reaches the agent,
 * chat, a file or a log, and each value is taken once.
 */
export interface McpOwnerChannel extends OwnerChannel {
	/** Hold a value the owner submitted through the capture form. */
	deposit(name: string, value: string): void;
}

export function createMcpOwnerChannel(): McpOwnerChannel {
	const held = new Map<string, string>();
	return {
		// The link travels in the run's refusal; nothing else is shown here.
		openUrl: async () => undefined,
		holds: (name) => held.has(name),
		async captureSecret({ name }) {
			const value = held.get(name);
			held.delete(name);
			return value;
		},
		deposit(name, value) {
			held.set(name, value);
		},
	};
}

// public-contract: the capture name of Infisical's copied CLI session.
export const INFISICAL_CLI_SESSION = INFISICAL_CLI_SESSION_CAPTURE;

const handoff = (
	name: string,
	label: string,
	purpose: string,
	limits: {
		readonly minBytes: number;
		readonly maxBytes: number;
		readonly pattern: string;
	},
) =>
	secretCaptureSpec({
		name,
		target: "handoff",
		label,
		purpose,
		charset: "printable-line",
		...limits,
	});

/** What the owner can hand to a waiting ceremony (never to a store). */
export const OWNER_HANDOFF_SPECS: readonly ParsedSecretCaptureSpec[] =
	Object.freeze([
		handoff(
			INFISICAL_CLI_SESSION,
			"Infisical sign-in (what “Copy to clipboard” copies)",
			'After you sign in, Infisical says "Unable to reach CLI": its Copy to clipboard button copies your session for this run. HoBo uses it once to set up its own access and keeps nothing.',
			{ minBytes: 20, maxBytes: 16384, pattern: "^[A-Za-z0-9+/=]+$" },
		),
		handoff(
			GITHUB_APP_CODE_CAPTURE,
			"GitHub App code (what HoBo's page shows)",
			"After you create the App on GitHub, HoBo's page shows a single-use code. This run redeems it once and puts the App's credentials straight into your store.",
			{
				minBytes: 3,
				maxBytes: 401,
				pattern: "^[A-Za-z0-9_-]{1,200}~[A-Za-z0-9_-]{1,200}$",
			},
		),
		handoff(
			BITWARDEN_API_KEY_CAPTURES[0],
			"Bitwarden API key: client_id",
			"Your personal API key's client_id (Account settings → Security → Keys → View API key). This run signs in with it once.",
			{ minBytes: 10, maxBytes: 64, pattern: "^user\\.[0-9a-fA-F-]{36}$" },
		),
		handoff(
			BITWARDEN_API_KEY_CAPTURES[1],
			"Bitwarden API key: client_secret",
			"Your personal API key's client_secret. This run signs in with it once and keeps nothing.",
			{ minBytes: 20, maxBytes: 256, pattern: "^[A-Za-z0-9]{20,}$" },
		),
		handoff(
			ONE_PASSWORD_SIGN_IN_CAPTURES[0],
			"1Password email",
			"The email you sign in to 1Password with. Used once, with your Secret Key and password, so HoBo can create its own service account.",
			{ minBytes: 3, maxBytes: 254, pattern: "^[^@\\s]+@[^@\\s]+$" },
		),
		handoff(
			ONE_PASSWORD_SIGN_IN_CAPTURES[1],
			"1Password Secret Key",
			"Your Secret Key (A3-…), from your 1Password app's account details or your Emergency Kit. Used once; never stored.",
			{ minBytes: 20, maxBytes: 64, pattern: "^A3-[A-Z0-9-]{20,60}$" },
		),
		handoff(
			ONE_PASSWORD_SIGN_IN_CAPTURES[2],
			"1Password password",
			"Your 1Password account password. Used once, on this run's standard input only; never stored.",
			{ minBytes: 1, maxBytes: 1024, pattern: "" },
		),
		handoff(
			"HOBO_CI_PUBLIC_URL",
			"Relay URL",
			"The hosted relay's https origin; GitHub sends its webhooks there. Not a secret; kept in your store with HoBo CI's settings.",
			{ minBytes: 9, maxBytes: 256, pattern: "^https://[^\\s/]+/?$" },
		),
		handoff(
			"HOBO_CI_GITHUB_OWNER",
			"GitHub owner",
			"The GitHub user or organization login that will own HoBo CI's App. Not a secret.",
			{ minBytes: 1, maxBytes: 39, pattern: "^[A-Za-z0-9-]{1,39}$" },
		),
	]);
