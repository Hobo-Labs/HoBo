import { randomUUID } from "node:crypto";

import { createTrustedVault } from "@hobo/core";
import {
	BITWARDEN_API_KEY_CAPTURES,
	createOwnerJobs,
	GITHUB_APP_CODE_CAPTURE,
	HAND_OFF_SIGN_IN_CAPTURES,
	INFISICAL_CLI_SESSION_CAPTURE,
	ONE_PASSWORD_SIGN_IN_CAPTURES,
	type OwnerChannel,
	type OwnerJobs,
} from "@hobo/hobo-ci";
import {
	createSecretCaptureApp,
	linkField,
	type ParsedSecretCaptureSpec,
	type SecretCaptureApp,
	type SecretStoreConnector,
	secretCaptureSpec,
} from "@hobo/mcp";

import { z } from "zod";

import type { JsonObject, JsonValue } from "./json.js";
import { RELAY_SECRET_CAPTURE_SPECS } from "./mcp-secret-capture.js";

/** A confirmation the owner submitted with Done ticked (not declined, closed or unticked). */
const Accepted = z.object({
	action: z.literal("accept"),
	content: z.object({ done: z.literal(true) }).loose(),
});

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
		/** Ask the host for a prompt (`elicitation/create`). */
		readonly prompt?: (params: JsonObject) => Promise<void>;
		/** Send the host a notification. */
		readonly notify?: (method: string, params: JsonValue) => void;
		/**
		 * Ask the host for a form and wait for the owner's answer; `undefined`
		 * when this host shows no forms (it said so at initialize).
		 */
		readonly form?: (
			params: JsonObject,
		) => Promise<JsonValue | undefined> | undefined;
		/**
		 * Open the capture form for a value the waiting run needs now (its
		 * link in the form); the value the owner submits is deposited here.
		 * `false` when this host shows no form.
		 */
		readonly ask?: (name: string) => Promise<boolean>;
	} = {},
): McpOwnerChannel {
	const held = new Map<string, string>();
	const links = new Map<string, { url: string; message: string }>();
	// Each prompt belongs to a job, even when several jobs share one URL.
	const prompted = new Map<string, string>();
	// Each capture's link, by its name: shown before that capture's form.
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
			// A host that shows forms: the run asks the owner now, the link in
			// the form, and goes on with what they submit in this same call.
			if (!held.has(name) && link !== undefined)
				await options.ask?.(name).catch(() => false);
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
		// A link the owner opens while a step waits on them (Vercel's device
		// code): the host's own link prompt, since no progress line reaches
		// them through MCP.
		async show(url, message, jobKey) {
			const elicitationId = `hobo-${randomUUID()}`;
			prompted.set(jobKey, elicitationId);
			await options.prompt?.({ mode: "url", elicitationId, url, message });
		},
		async confirm({ url, message }) {
			const answer = options.form?.({
				mode: "form",
				// One line, and the link as its own field (prefilled, marked as a
				// link): an address in the text could be neither clicked nor
				// copied.
				message,
				requestedSchema: {
					type: "object",
					properties: {
						link: linkField(url, "Approval link"),
						done: { type: "boolean", title: "Done", default: true },
					},
				},
			});
			if (answer === undefined) return undefined;
			return Accepted.safeParse(await answer).success;
		},
		// Steps that wait on the owner run here, off the request path, for as
		// long as this server lives; when one ends, the prompt it showed is
		// completed, so the host (and the agent) know without asking.
		jobs: createOwnerJobs({
			onSettled: (key) => {
				const elicitationId = prompted.get(key);
				if (elicitationId === undefined) return;
				prompted.delete(key);
				options.notify?.("notifications/elicitation/complete", {
					elicitationId,
				});
			},
		}),
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
			HAND_OFF_SIGN_IN_CAPTURES[0],
			"Infisical access token",
			"A Token Auth access token for your Infisical identity.",
			{
				minBytes: 40,
				maxBytes: 8192,
				pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
			},
		),
		handoff(
			HAND_OFF_SIGN_IN_CAPTURES[1],
			"1Password Connect token",
			"A Connect server access token with access to the vault.",
			{
				minBytes: 40,
				maxBytes: 8192,
				pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
			},
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
		handoffHeld: (name) => options.owner.holds(name),
		// The owner is elsewhere: no page on this box's 127.0.0.1 for them;
		// the host's own elicitation form asks when it shows no MCP App.
		remote: options.remote,
		linkFor: (name) => options.owner.linkFor(name),
		elicit: options.elicit,
		connector: options.connector,
		...(options.notify !== undefined ? { notify: options.notify } : undefined),
	});
}
