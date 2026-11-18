import { randomUUID } from "node:crypto";

import type { SettingsStore } from "@hobo/connect-ui";
import { createTrustedVault, type TrustedVault } from "@hobo/core";
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
	handoffFor: NonNullable<
		Parameters<typeof createSecretCaptureApp>[0]["handoffFor"]
	>;
	cancelScope(family: "ci" | "cd", cwd: string): void;
	cancelAll(): void;
	close(): void;
}

export function createMcpOwnerChannel(
	options: {
		readonly storeSettings?: SettingsStore;
		readonly storeSettingsFor?: (
			family: "ci" | "cd",
			cwd: string,
		) => SettingsStore;
		readonly vaultFor?: (family: "ci" | "cd", cwd: string) => TrustedVault;
		readonly scopeKey?: (family: "ci" | "cd", cwd: string) => string;
		readonly requireScope?: boolean;
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
		readonly canConfirm?: () => boolean;
		/**
		 * Open the capture form for a value the waiting run needs now (its
		 * link in the form); the value the owner submits is deposited here.
		 * `false` when this host shows no form.
		 */
		readonly ask?: (name: string) => Promise<boolean>;
	} = {},
): McpOwnerChannel {
	type Link = { url: string; message: string };
	type Handoff = NonNullable<ReturnType<McpOwnerChannel["handoffFor"]>>;
	type Lease = {
		scope: string;
		expiresAt: number;
		value?: string;
		link?: Link;
		opened?: Link;
		handoff: Handoff;
	};
	const waiting = new Map<string, Lease>();
	const epochs = new Map<string, number>();
	let closed = false;
	const cancelScope = (scope: string) => {
		epochs.set(scope, (epochs.get(scope) ?? 0) + 1);
		for (const [name, lease] of waiting) {
			if (lease.scope !== scope) continue;
			delete lease.value;
			waiting.delete(name);
		}
	};
	const sweep = () => {
		for (const lease of waiting.values())
			if (Date.now() >= lease.expiresAt) cancelScope(lease.scope);
	};
	const reserve = (scope: string, names: readonly string[]) => {
		if (closed) throw new Error("The owner session is closed.");
		sweep();
		if (
			names.some(
				(name) => waiting.has(name) && waiting.get(name)?.scope !== scope,
			)
		)
			throw new Error(
				"Another project or service is waiting for an owner handoff. Finish it before starting another.",
			);
		for (const name of names) {
			if (waiting.has(name)) continue;
			const lease: Lease = {
				scope,
				expiresAt: Date.now() + 10 * 60_000,
				handoff: {
					held: () => waiting.get(name) === lease && lease.value !== undefined,
					link: () => (waiting.get(name) === lease ? lease.link : undefined),
					cancel: () => {
						if (waiting.get(name) === lease) cancelScope(scope);
					},
					receive: async (secret) => {
						if (closed || waiting.get(name) !== lease)
							throw new Error("The owner handoff is no longer waiting.");
						lease.value = secret.reveal();
					},
				},
			};
			waiting.set(name, lease);
		}
	};
	const defaultScope = "unscoped";
	const pending = (name: string) => {
		sweep();
		if (!waiting.has(name) && !options.requireScope && !closed)
			reserve(defaultScope, [name]);
		return waiting.get(name);
	};
	// Each prompt belongs to a job, even when several jobs share one URL.
	const prompted = new Map<string, string>();
	const methods = (
		scope: string,
		epoch = epochs.get(scope) ?? 0,
	): Pick<
		OwnerChannel,
		| "openUrl"
		| "captureSecret"
		| "holds"
		| "reserveCaptures"
		| "requestCaptures"
	> => ({
		reserveCaptures: (names) => {
			sweep();
			if ((epochs.get(scope) ?? 0) !== epoch)
				throw new Error(
					"The owner session changed. Start this operation again.",
				);
			reserve(scope, names);
		},
		async requestCaptures(names) {
			sweep();
			if ((epochs.get(scope) ?? 0) !== epoch)
				throw new Error(
					"The owner session changed. Start this operation again.",
				);
			reserve(scope, names);
			for (const name of names) {
				const lease = waiting.get(name);
				if (!lease || lease.scope !== scope) return;
				if (lease.value === undefined) {
					const shown = await options.ask?.(name).catch(() => false);
					if (
						!shown ||
						waiting.get(name) !== lease ||
						lease.value === undefined
					)
						return;
				}
			}
		},
		async openUrl(url, message, name) {
			sweep();
			if ((epochs.get(scope) ?? 0) !== epoch)
				throw new Error(
					"The owner session changed. Start this operation again.",
				);
			reserve(scope, [name]);
			const lease = waiting.get(name);
			if (lease) lease.opened = { url, message };
		},
		async captureSecret({ name }) {
			sweep();
			if ((epochs.get(scope) ?? 0) !== epoch)
				throw new Error(
					"The owner session changed. Start this operation again.",
				);
			reserve(scope, [name]);
			const lease = waiting.get(name);
			if (!lease) return undefined;
			const link = lease.opened;
			delete lease.opened;
			if (link) lease.link = link;
			else delete lease.link;
			if (lease.value === undefined && link !== undefined)
				await options.ask?.(name).catch(() => false);
			if (waiting.get(name) !== lease) return undefined;
			const value = lease.value;
			if (value !== undefined) {
				delete lease.value;
				waiting.delete(name);
			}
			return value;
		},
		holds: (name) =>
			(epochs.get(scope) ?? 0) === epoch &&
			waiting.get(name)?.scope === scope &&
			waiting.get(name)?.value !== undefined,
	});
	const owner: McpOwnerChannel = {
		privateSubprocessAllowed: false,
		...(options.storeSettings
			? { storeSettings: options.storeSettings }
			: undefined),
		...(options.storeSettingsFor
			? { storeSettingsFor: options.storeSettingsFor }
			: undefined),
		...(options.vaultFor ? { vaultFor: options.vaultFor } : undefined),
		...methods(defaultScope),
		forScope: (family, cwd) => {
			const scope = options.scopeKey?.(family, cwd) ?? `${family}\u0000${cwd}`;
			if (!epochs.has(scope)) epochs.set(scope, 0);
			return { ...owner, ...methods(scope) };
		},
		deposit(name, value) {
			const lease = pending(name);
			if (!lease) throw new Error("The owner handoff is no longer waiting.");
			lease.value = value;
		},
		linkFor: (name) => waiting.get(name)?.link,
		handoffFor: (name) => {
			const lease = pending(name);
			if (lease) lease.expiresAt = Date.now() + 10 * 60_000;
			return lease?.handoff;
		},
		cancelScope: (family, cwd) =>
			cancelScope(options.scopeKey?.(family, cwd) ?? `${family}\u0000${cwd}`),
		cancelAll() {
			for (const scope of epochs.keys())
				epochs.set(scope, (epochs.get(scope) ?? 0) + 1);
			for (const lease of waiting.values()) delete lease.value;
			waiting.clear();
		},
		close() {
			closed = true;
			for (const lease of waiting.values()) delete lease.value;
			waiting.clear();
			epochs.clear();
			prompted.clear();
		},
		// A link the owner opens while a step waits on them (Vercel's device
		// code): the host's own link prompt, since no progress line reaches
		// them through MCP.
		async show(url, message, jobKey) {
			if (options.prompt === undefined) return;
			const elicitationId = `hobo-${randomUUID()}`;
			prompted.set(jobKey, elicitationId);
			await options.prompt?.({ mode: "url", elicitationId, url, message });
		},
		async confirm({ url, message }) {
			const answer = options.form?.({
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
		canConfirm: () => options.canConfirm?.() === true,
		async choose({ message, choices }) {
			if (options.canConfirm?.() !== true || choices.length === 0)
				return undefined;
			const answer = await options.form?.({
				message,
				requestedSchema: {
					type: "object",
					properties: {
						choice: {
							type: "string",
							title: "Organization",
							enum: choices.map((item) => item.value),
							enumNames: choices.map((item) => item.label),
						},
					},
					required: ["choice"],
				},
			});
			const parsed = z
				.object({
					action: z.literal("accept"),
					content: z.object({ choice: z.string() }),
				})
				.safeParse(answer);
			return parsed.success &&
				choices.some((item) => item.value === parsed.data.content.choice)
				? parsed.data.content.choice
				: undefined;
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
	return owner;
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
		handoffFor: (name) => options.owner.handoffFor(name),
		onEnd: () => options.owner.cancelAll(),
		// The owner is elsewhere: no page on this box's 127.0.0.1 for them;
		// the host's own elicitation form asks when it shows no MCP App.
		remote: options.remote,
		linkFor: (name) => options.owner.linkFor(name),
		elicit: options.elicit,
		connector: options.connector,
		...(options.notify !== undefined ? { notify: options.notify } : undefined),
	});
}
