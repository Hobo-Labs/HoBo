import { createTrustedVault } from "@hobo/core";
import {
	BITWARDEN_API_KEY_CAPTURES,
	createOwnerJobs,
	GITHUB_APP_CODE_CAPTURE,
	INFISICAL_CLI_SESSION_CAPTURE,
	ONE_PASSWORD_SIGN_IN_CAPTURES,
	type OwnerChannel,
	type OwnerJobs,
} from "@hobo/hobo-ci";
import {
	createSecretCaptureApp,
	type ParsedSecretCaptureSpec,
	type SecretCaptureApp,
	type SecretStoreConnector,
	secretCaptureSpec,
} from "@hobo/mcp";

import type { JsonObject, JsonValue } from "./json.js";
import { RELAY_SECRET_CAPTURE_SPECS } from "./mcp-secret-capture.js";

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
	readonly jobs: OwnerJobs;
	/** Hold a value the owner submitted through the capture form. */
	deposit(name: string, value: string): void;
	/** The link the waiting run gave for a value, to show before its form. */
	linkFor(name: string): Readonly<{ url: string; message: string }> | undefined;
}

export function createMcpOwnerChannel(
	options: {
		/** Ask the host to show a link now (URL-mode elicitation). */
		readonly show?: (url: string, message: string) => Promise<void>;
	} = {},
): McpOwnerChannel {
	const held = new Map<string, string>();
	const links = new Map<string, { url: string; message: string }>();
	const opened = new Map<string, { url: string; message: string }>();
	return {
		// Key the link by its capture: concurrent runs may interleave here.
		async openUrl(url, message, captureName) {
			opened.set(captureName, { url, message });
		},
		async captureSecret({ name }) {
			const link = opened.get(name);
			opened.delete(name);
			if (link !== undefined) links.set(name, link);
			else links.delete(name);
			const value = held.get(name);
			held.delete(name);
			if (value !== undefined) links.delete(name);
			return value;
		},
		holds: (name) => held.has(name),
		deposit(name, value) {
			held.set(name, value);
		},
		linkFor: (name) => links.get(name),
		...(options.show !== undefined ? { show: options.show } : undefined),
		// Steps that wait on the owner run here, off the request path, for as
		// long as this server lives.
		jobs: createOwnerJobs(),
		// The store sign-in HoBo created, kept in this process's memory so the
		// owner signs in once; never a file, gone when the server stops.
		vault: createTrustedVault(),
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
			"Infisical session",
			"Paste what Infisical copied after you signed in.",
			{ minBytes: 20, maxBytes: 16384, pattern: "^[A-Za-z0-9+/=]+$" },
		),
		handoff(
			GITHUB_APP_CODE_CAPTURE,
			"GitHub App code",
			"Paste the code HoBo's page showed after you created the App.",
			{
				minBytes: 3,
				maxBytes: 401,
				pattern: "^[A-Za-z0-9_-]{1,200}~[A-Za-z0-9_-]{1,200}$",
			},
		),
		handoff(
			BITWARDEN_API_KEY_CAPTURES[0],
			"Bitwarden client_id",
			"Account settings → Security → Keys → View API key.",
			{ minBytes: 10, maxBytes: 64, pattern: "^user\\.[0-9a-fA-F-]{36}$" },
		),
		handoff(
			BITWARDEN_API_KEY_CAPTURES[1],
			"Bitwarden client_secret",
			"Account settings → Security → Keys → View API key.",
			{ minBytes: 20, maxBytes: 256, pattern: "^[A-Za-z0-9]{20,}$" },
		),
		handoff(
			ONE_PASSWORD_SIGN_IN_CAPTURES[0],
			"1Password email",
			"The email you sign in to 1Password with.",
			{ minBytes: 3, maxBytes: 254, pattern: "^[^@\\s]+@[^@\\s]+$" },
		),
		handoff(
			ONE_PASSWORD_SIGN_IN_CAPTURES[1],
			"1Password Secret Key",
			"Starts with A3-: in your 1Password app or Emergency Kit.",
			{ minBytes: 20, maxBytes: 64, pattern: "^A3-[A-Z0-9-]{20,60}$" },
		),
		handoff(
			ONE_PASSWORD_SIGN_IN_CAPTURES[2],
			"1Password password",
			"Used once to sign in; never stored.",
			{ minBytes: 1, maxBytes: 1024, pattern: "" },
		),
		handoff(
			"HOBO_CI_PUBLIC_URL",
			"Relay URL",
			"The relay's https address; GitHub sends webhooks there.",
			{ minBytes: 9, maxBytes: 256, pattern: "^https://[^\\s/]+/?$" },
		),
		handoff(
			"HOBO_CI_GITHUB_OWNER",
			"GitHub owner",
			"The GitHub user or organization that owns the App.",
			{ minBytes: 1, maxBytes: 39, pattern: "^[A-Za-z0-9-]{1,39}$" },
		),
	]);

/** The capture app of the HoBo MCP server: relay secrets, and hand-overs to a waiting run. */
export function createOwnerCaptureApp(options: {
	readonly owner: McpOwnerChannel;
	readonly connector: SecretStoreConnector;
	readonly remote: boolean;
	readonly elicit: (params: JsonObject) => Promise<JsonValue | undefined>;
	readonly notify?: (method: string, params: JsonValue) => void;
}): SecretCaptureApp {
	return createSecretCaptureApp({
		specs: [...RELAY_SECRET_CAPTURE_SPECS, ...OWNER_HANDOFF_SPECS],
		handoff: async (secret) =>
			options.owner.deposit(secret.name, secret.reveal()),
		// The owner is elsewhere: no page on this box's 127.0.0.1 for them;
		// the host's own elicitation form asks when it shows no MCP App.
		remote: options.remote,
		linkFor: (name) => options.owner.linkFor(name),
		elicit: options.elicit,
		connector: options.connector,
		...(options.notify !== undefined ? { notify: options.notify } : undefined),
	});
}
