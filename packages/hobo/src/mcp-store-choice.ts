import path from "node:path";

import type { SettingsStore } from "@hobo/connect-ui";
import {
	ownerLocator,
	parseHttpsOrigin,
	parseOnePasswordVaultId,
	SettingParseError,
} from "@hobo/hobo-ci";
import { z } from "zod";

import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import type {
	OwnerLinkAnswer,
	OwnerLinkChannel,
	OwnerLinkOutcome,
	OwnerLinkUnavailableReason,
} from "./owner-link.js";
import type {
	OwnerSessionState,
	OwnerStoreLabel,
	OwnerStoreSessions,
} from "./owner-store-session.js";

// public-contract: the MCP tool that asks the owner to choose their secret store.
export const CHOOSE_SECRET_STORE_TOOL = "choose_secret_store";
// public-contract: the MCP App-only tool that records the owner's store choice from the picker widget.
export const SUBMIT_STORE_CHOICE_TOOL = "submit_store_choice";
// public-contract: the MCP App resource of the store picker.
export const STORE_CHOICE_RESOURCE_URI = "ui://hobo/store-choice";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

export const STORE_CHOICE_TOOL_NAMES: readonly string[] = Object.freeze([
	CHOOSE_SECRET_STORE_TOOL,
	SUBMIT_STORE_CHOICE_TOOL,
]);

export type StoreChoiceSupport = Readonly<{
	formElicitation: boolean;
	apps: boolean;
}>;

export const NO_STORE_CHOICE_SUPPORT: StoreChoiceSupport = Object.freeze({
	formElicitation: false,
	apps: false,
});

/** Read the client's `initialize` capabilities. Anything malformed means "no". */
export function negotiateStoreChoiceSupport(
	capabilities: JsonValue | undefined,
): StoreChoiceSupport {
	if (!isJsonObject(capabilities)) return NO_STORE_CHOICE_SUPPORT;
	const elicitation = capabilities.elicitation;
	// `{}` (2025-06-18) or `{ form: {} }` (2025-11-25) both mean form mode.
	const formElicitation =
		isJsonObject(elicitation) &&
		(Object.keys(elicitation).length === 0 || isJsonObject(elicitation.form));
	const extensions = capabilities.extensions;
	const ui = isJsonObject(extensions)
		? extensions[MCP_APPS_EXTENSION_ID]
		: undefined;
	const mimeTypes = isJsonObject(ui) ? ui.mimeTypes : undefined;
	const apps =
		Array.isArray(mimeTypes) && mimeTypes.some((m) => m === MCP_APP_MIME_TYPE);
	return Object.freeze({ formElicitation, apps });
}

/** The three stores as the owner sees them; an id is for the run only. */
export const STORE_OPTIONS = [
	{
		id: "infisical",
		label: "Infisical",
		needs: "its project ID",
	},
	{
		id: "1password",
		label: "1Password",
		needs: "the vault ID and, from a remote box, your Connect server",
	},
	{
		id: "bitwarden",
		label: "Bitwarden",
		needs: "nothing to look up",
	},
] as const;

/** The elicitation's form: the choice and non-secret ids only. */
export const STORE_CHOICE_PROPERTIES: JsonObject = {
	store: {
		type: "string",
		title: "Secret store",
		description:
			"Where HoBo keeps this project's credentials. Its sign-in is asked for separately, never here.",
		enum: STORE_OPTIONS.map((o) => o.id),
		enumNames: STORE_OPTIONS.map((o) => o.label),
	},
	INFISICAL_PROJECT_ID: {
		type: "string",
		title: "Infisical project ID (Infisical only)",
	},
	OP_VAULT_ID: { type: "string", title: "1Password vault ID (1Password only)" },
	OP_CONNECT_HOST: {
		type: "string",
		title: "1Password Connect server (1Password only)",
		format: "uri",
	},
	BITWARDEN_SERVER_URL: {
		type: "string",
		title: "Self-hosted server (Bitwarden only, optional)",
		format: "uri",
	},
};

/**
 * The first form: the store alone. A store's own fields come in a second
 * form, after the owner chose it, so no one is asked about a store they did
 * not choose.
 */
export const STORE_CHOICE_SCHEMA: JsonObject = {
	type: "object",
	properties: { store: STORE_CHOICE_PROPERTIES.store ?? null },
	required: ["store"],
};

/** The second form: only the chosen store's non-secret fields. */
export function storeFieldsSchema(
	store: "infisical" | "1password" | "bitwarden",
): JsonObject {
	const pick = (names: readonly string[]): JsonObject =>
		Object.fromEntries(
			names.map((name) => [name, STORE_CHOICE_PROPERTIES[name] ?? null]),
		);
	switch (store) {
		case "infisical":
			return {
				type: "object",
				properties: pick(["INFISICAL_PROJECT_ID"]),
				required: ["INFISICAL_PROJECT_ID"],
			};
		case "1password":
			return {
				type: "object",
				properties: pick(["OP_VAULT_ID", "OP_CONNECT_HOST"]),
				required: ["OP_VAULT_ID"],
			};
		case "bitwarden":
			return {
				type: "object",
				properties: pick(["BITWARDEN_SERVER_URL"]),
				required: [],
			};
	}
}

export class StoreChoiceInvalid extends Error {
	constructor(readonly rule: string) {
		super(rule);
		this.name = "StoreChoiceInvalid";
	}
}

/** What the owner chose, parsed: one shape per store. */
export type StoreChoice =
	| { readonly store: "infisical"; readonly projectId: string }
	| {
			readonly store: "1password";
			readonly vaultId: string;
			readonly connectHost: string | undefined;
	  }
	| { readonly store: "bitwarden"; readonly serverUrl: string | undefined };

const field = z
	.string()
	.transform((value) => value.trim())
	.optional()
	.transform((value) => (value === "" ? undefined : value));
const answerSchema = z.object({
	store: z.enum(["infisical", "1password", "bitwarden"], {
		message: "Choose Infisical, 1Password or Bitwarden.",
	}),
	INFISICAL_PROJECT_ID: field,
	OP_VAULT_ID: field,
	OP_CONNECT_HOST: field,
	BITWARDEN_SERVER_URL: field,
});

/** Parse an answer, or say which rule it broke. */
export function parseStoreChoice(answer: JsonValue | undefined): StoreChoice {
	const parsed = answerSchema.safeParse(answer);
	if (!parsed.success)
		throw new StoreChoiceInvalid("Choose Infisical, 1Password or Bitwarden.");
	const a = parsed.data;
	try {
		if (a.store === "infisical") {
			if (a.INFISICAL_PROJECT_ID === undefined)
				throw new StoreChoiceInvalid(
					"Infisical needs its project ID (Project Settings in Infisical).",
				);
			return { store: "infisical", projectId: a.INFISICAL_PROJECT_ID };
		}
		if (a.store === "1password")
			return {
				store: "1password",
				vaultId: parseOnePasswordVaultId("OP_VAULT_ID", a.OP_VAULT_ID ?? ""),
				connectHost:
					a.OP_CONNECT_HOST === undefined
						? undefined
						: parseHttpsOrigin("OP_CONNECT_HOST", a.OP_CONNECT_HOST),
			};
		return {
			store: "bitwarden",
			serverUrl:
				a.BITWARDEN_SERVER_URL === undefined
					? undefined
					: parseHttpsOrigin("BITWARDEN_SERVER_URL", a.BITWARDEN_SERVER_URL),
		};
	} catch (error) {
		if (error instanceof SettingParseError)
			throw new StoreChoiceInvalid(error.message);
		throw error;
	}
}

/** The choice as the locator keeps it (the settings a run reads). */
export function locatorSettings(choice: StoreChoice) {
	switch (choice.store) {
		case "infisical":
			return {
				HOBO_SECRET_STORE: choice.store,
				INFISICAL_PROJECT_ID: choice.projectId,
			};
		case "1password":
			return {
				HOBO_SECRET_STORE: choice.store,
				OP_VAULT_ID: choice.vaultId,
				...(choice.connectHost !== undefined
					? { OP_CONNECT_HOST: choice.connectHost }
					: undefined),
			};
		case "bitwarden":
			return {
				HOBO_SECRET_STORE: choice.store,
				...(choice.serverUrl !== undefined
					? { BITWARDEN_SERVER_URL: choice.serverUrl }
					: undefined),
			};
	}
}

export interface StoreChoiceToolDefinition {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: JsonObject;
	readonly _meta?: JsonObject;
}

export interface CallToolResult {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly structuredContent?: JsonObject;
	readonly isError?: boolean;
	readonly _meta?: JsonObject;
}

export type ClientRequest = (
	method: string,
	params: JsonObject,
) => Promise<JsonValue | undefined>;

// public-contract: a form answered cancel or decline sooner than this was not answered by a person.
export const FAST_FORM_ANSWER_MS = 1_500;

export interface FormHealth {
	watch(request: ClientRequest): ClientRequest;
	broken(): boolean;
}

export function createFormHealth(
	options: { readonly now?: () => number; readonly fastAnswerMs?: number } = {},
): FormHealth {
	const now = options.now ?? Date.now;
	const fastAnswerMs = options.fastAnswerMs ?? FAST_FORM_ANSWER_MS;
	let broken = false;
	return {
		watch: (request) => async (method, params) => {
			if (method !== "elicitation/create") return request(method, params);
			const started = now();
			const answer = await request(method, params);
			const parsed = elicitResult.safeParse(answer);
			if (parsed.success && parsed.data.action === "accept") broken = false;
			else if (parsed.success && now() - started < fastAnswerMs) broken = true;
			return answer;
		},
		broken: () => broken,
	};
}

export const SIGN_IN_FIELDS: Readonly<
	Record<StoreChoice["store"], readonly string[]>
> = Object.freeze({
	infisical: ["INFISICAL_CLI_SESSION"],
	"1password": [
		"ONEPASSWORD_EMAIL",
		"ONEPASSWORD_SECRET_KEY",
		"ONEPASSWORD_PASSWORD",
	],
	bitwarden: ["BW_CLIENTID", "BW_CLIENTSECRET"],
});

export interface StoreChoiceApp {
	handles(tool: string): boolean;
	tools(support: StoreChoiceSupport): readonly StoreChoiceToolDefinition[];
	resources(support: StoreChoiceSupport): readonly JsonObject[];
	readResource(uri: string): JsonObject | undefined;
	callTool(
		tool: string,
		args: JsonObject,
		support: StoreChoiceSupport,
		request: ClientRequest | undefined,
	): Promise<CallToolResult>;
}

const storeOnly = z.object({
	store: z.enum(["infisical", "1password", "bitwarden"]),
});

const elicitResult = z.object({
	action: z.enum(["accept", "decline", "cancel"]),
	content: z.unknown().optional(),
});

const callArgs = z
	.object({
		cwd: z.string().trim().min(1).optional().catch(undefined),
		reselect: z.boolean().optional().catch(undefined),
	})
	.loose();

const chosenStore = z.object({
	HOBO_SECRET_STORE: z.enum(["infisical", "1password", "bitwarden"]),
});

function result(
	message: string,
	structured: JsonObject,
	isError = false,
): CallToolResult {
	return {
		content: [{ type: "text", text: message }],
		structuredContent: structured,
		...(isError ? { isError: true } : undefined),
	};
}

function labelFor(store: StoreChoice["store"]): OwnerStoreLabel {
	return STORE_OPTIONS.find((o) => o.id === store)?.label ?? "Infisical";
}

function linkUnavailable(reason: OwnerLinkUnavailableReason): CallToolResult {
	const why = {
		"owner-link-relay-unconfigured":
			"no HoBo CI relay is configured for this project (HOBO_CI_RELAY_URL or .hobo/ci.json)",
		"owner-link-relay-unreachable": "HoBo's relay could not be reached",
		"owner-link-relay-not-ready": "HoBo's relay has no hand-off mailbox ready",
		"owner-link-relay-refused": "HoBo's relay refused the hand-off",
	} satisfies Record<OwnerLinkUnavailableReason, string>;
	return result(
		`This host shows no working private form, and HoBo's private link is unavailable: ${why[reason]}. Nothing was collected or saved. Report that this host cannot provide a secure HoBo owner hand-off (${reason}); do not ask the owner for store settings in chat.`,
		{ status: "secure-form-unavailable", reason },
		true,
	);
}

function linkResult(
	outcome: Extract<OwnerLinkOutcome, { kind: "issued" | "waiting" }>,
	waitedMs: number,
): CallToolResult {
	const minutes = Math.max(
		1,
		Math.round((outcome.expiresAtMs - Date.now()) / 60_000),
	);
	const text =
		outcome.kind === "issued"
			? `This host shows no working private form, so HoBo opened a one-time private link for the owner. Show the owner this link and ask them to open it on any device: ${outcome.url} It carries only a single-use ticket, works for about ${minutes} minutes, and what they enter there is encrypted for this HoBo session alone. Then call choose_secret_store again with the same cwd; it waits for their answer.`
			: `The owner has not finished the private link yet (waited ${Math.round(waitedMs / 1000)} seconds). If they have not opened it, show them this link again: ${outcome.url} Then call choose_secret_store again with the same cwd.`;
	return result(text, {
		status: "link",
		url: outcome.url,
		waiting: outcome.kind === "waiting",
	});
}

const UNAVAILABLE = result(
	"This host renders neither MCP form elicitation nor MCP Apps, so HoBo cannot ask the owner privately. Nothing was collected or saved. Report that this host cannot provide a secure HoBo owner hand-off; do not ask the owner for store settings in chat.",
	{ status: "secure-form-unavailable", reason: "no-private-owner-form" },
	true,
);

const NOT_SAVED = result(
	"The owner's settings could not be read or saved; nothing was recorded. Call choose_secret_store again.",
	{ status: "unavailable" },
	true,
);

function sessionResult(
	state: OwnerSessionState | undefined,
	label: OwnerStoreLabel,
): CallToolResult {
	if (state === undefined)
		return result(
			`The owner chose ${label}; it is saved in their own HoBo settings. This server holds no store session.`,
			{ status: "chosen", store: label },
		);
	switch (state.status) {
		case "established":
			return result(
				`The owner chose ${state.store}; its store session is established for this project. HoBo verbs read the credentials they need from it; nothing is returned to you.`,
				{ status: "established", store: state.store },
			);
		case "sign-in-needed":
			return result(
				`The owner chose ${state.store}, and its sign-in has not completed (${state.code}). Call choose_secret_store again when the owner is ready; their choice is kept.`,
				{ status: "sign-in-needed", store: state.store, code: state.code },
				true,
			);
		case "unchosen":
			return result(
				"No store choice is saved for this project. Call choose_secret_store again.",
				{ status: "unchosen" },
				true,
			);
	}
}

const familyArg: JsonObject = {
	family: {
		type: "string",
		enum: ["ci", "cd"],
		description: "The lifecycle the store serves; both use the same session.",
	},
	cwd: {
		type: "string",
		description:
			"The project directory; the server's working directory by default.",
	},
};

const chooseArgs: JsonObject = {
	...familyArg,
	reselect: {
		type: "boolean",
		description:
			"Ask the owner to choose again even when a store is already chosen.",
	},
};

export function createStoreChoiceApp(
	options: {
		readonly cwd?: string;
		readonly locatorFor?: (cwd: string) => SettingsStore;
		readonly sessions?: OwnerStoreSessions;
		readonly link?: OwnerLinkChannel;
		readonly handOver?: (name: string, value: string) => void;
		readonly formHealth?: FormHealth;
		readonly linkWaitMs?: number;
	} = {},
): StoreChoiceApp {
	const locatorFor =
		options.locatorFor ?? ((cwd: string) => ownerLocator({ cwd }));
	const health = options.formHealth ?? createFormHealth();
	const linkWaitMs = options.linkWaitMs ?? 30_000;
	const awaitingWidget = new Set<string>();
	const cwdOf = (args: JsonObject) =>
		path.resolve(callArgs.parse(args).cwd ?? options.cwd ?? process.cwd());

	const establish = async (cwd: string, label: OwnerStoreLabel) => {
		const state = await options.sessions?.establish(cwd);
		return sessionResult(state, label);
	};

	const record = async (
		cwd: string,
		answer: JsonValue | undefined,
		signIn?: OwnerLinkAnswer,
	): Promise<CallToolResult> => {
		let choice: StoreChoice;
		try {
			choice = parseStoreChoice(answer);
		} catch (error) {
			if (!(error instanceof StoreChoiceInvalid)) throw error;
			return result(
				`Not recorded: ${error.rule} Call choose_secret_store again.`,
				{ status: "invalid", rule: error.rule },
				true,
			);
		}
		try {
			const locator = locatorFor(cwd);
			await locator.write({
				...(await locator.read()),
				...locatorSettings(choice),
			});
		} catch {
			return NOT_SAVED;
		}
		if (signIn !== undefined)
			for (const name of SIGN_IN_FIELDS[choice.store]) {
				const value = signIn[name];
				if (value !== undefined && value !== "")
					options.handOver?.(name, value);
			}
		return establish(cwd, labelFor(choice.store));
	};

	const issueLink = async (cwd: string): Promise<CallToolResult> => {
		const link = options.link;
		if (link === undefined) return UNAVAILABLE;
		const issued = await link.issue(cwd);
		if (issued.kind === "issued") return linkResult(issued, 0);
		if (issued.kind === "unavailable") return linkUnavailable(issued.reason);
		return linkUnavailable("owner-link-relay-refused");
	};

	const collectLink = async (
		cwd: string,
	): Promise<CallToolResult | undefined> => {
		const link = options.link;
		if (link === undefined || !link.pending(cwd)) return undefined;
		const started = Date.now();
		const collected = await link.collect(cwd, linkWaitMs);
		switch (collected.kind) {
			case "answered": {
				const answer: JsonObject = { ...collected.answer };
				return record(cwd, answer, collected.answer);
			}
			case "waiting":
				return linkResult(collected, Date.now() - started);
			case "unavailable":
				return linkUnavailable(collected.reason);
			case "issued":
			case "refused":
				return undefined;
		}
	};

	const hostCannotAsk = (support: StoreChoiceSupport) =>
		!support.apps && (!support.formElicitation || health.broken());

	const savedChoice = async (cwd: string) => {
		const saved = chosenStore.safeParse(await locatorFor(cwd).read());
		return saved.success ? saved.data.HOBO_SECRET_STORE : undefined;
	};

	const elicitChoice = async (
		cwd: string,
		request: ClientRequest,
	): Promise<CallToolResult> => {
		const unanswered = (action: string) =>
			result(
				`The owner ${action === "decline" ? "declined" : "closed"} the store picker; nothing was recorded. Call choose_secret_store again when they are ready.`,
				{ status: action === "decline" ? "decline" : "cancel" },
			);
		const first = elicitResult.safeParse(
			await request("elicitation/create", {
				message:
					"Choose where HoBo keeps this project's credentials. Its sign-in is asked for separately; nothing you enter here is shown to the agent.",
				requestedSchema: STORE_CHOICE_SCHEMA,
			}),
		);
		if (!first.success || first.data.action !== "accept")
			return unanswered(first.success ? first.data.action : "cancel");
		const picked = storeOnly.safeParse(first.data.content);
		if (!picked.success) return record(cwd, undefined);
		const store = picked.data.store;
		const option = STORE_OPTIONS.find((o) => o.id === store);
		const second = elicitResult.safeParse(
			await request("elicitation/create", {
				message: `${option?.label ?? store}: ${option?.needs ?? ""}. Only HoBo reads this.`,
				requestedSchema: storeFieldsSchema(store),
			}),
		);
		if (!second.success || second.data.action !== "accept")
			return unanswered(second.success ? second.data.action : "cancel");
		const fields = second.data.content;
		return record(cwd, isJsonObject(fields) ? { ...fields, store } : { store });
	};

	return {
		handles: (tool) => STORE_CHOICE_TOOL_NAMES.includes(tool),
		tools(support) {
			const choose: StoreChoiceToolDefinition = {
				name: CHOOSE_SECRET_STORE_TOOL,
				title: "Connect the owner's secret store",
				description:
					"Connect the owner's secret store to this HoBo session: reuse an established session, or ask the owner privately (a host form, HoBo's widget, or, where the host shows neither, a one-time private link to show the owner) which store to use and sign in. Takes no store settings; returns only a status, the store's name, and for status link the URL to show the owner. Call again with the same cwd after showing a link.",
				inputSchema: {
					type: "object",
					properties: chooseArgs,
					additionalProperties: false,
				},
				...(support.apps
					? {
							_meta: {
								ui: { resourceUri: STORE_CHOICE_RESOURCE_URI },
								"ui/resourceUri": STORE_CHOICE_RESOURCE_URI,
							},
						}
					: undefined),
			};
			if (!support.apps) return [choose];
			return [
				choose,
				{
					name: SUBMIT_STORE_CHOICE_TOOL,
					title: "Record the store choice",
					description:
						"Called only by HoBo's store picker widget with the owner's answer.",
					inputSchema: {
						type: "object",
						properties: { ...familyArg, ...STORE_CHOICE_PROPERTIES },
						required: ["store"],
						additionalProperties: false,
					},
					_meta: {
						ui: {
							resourceUri: STORE_CHOICE_RESOURCE_URI,
							visibility: ["app"],
						},
					},
				},
			];
		},
		resources(support) {
			return support.apps
				? [
						{
							uri: STORE_CHOICE_RESOURCE_URI,
							name: "hobo-store-choice",
							title: "Choose your secret store",
							mimeType: MCP_APP_MIME_TYPE,
						},
					]
				: [];
		},
		readResource(uri) {
			if (uri !== STORE_CHOICE_RESOURCE_URI) return undefined;
			return {
				contents: [
					{
						uri,
						mimeType: MCP_APP_MIME_TYPE,
						text: renderStoreChoiceHtml(),
						_meta: {
							ui: {
								csp: { connectDomains: [], resourceDomains: [] },
								prefersBorder: true,
							},
						},
					},
				],
			};
		},
		async callTool(tool, args, support, request) {
			const cwd = cwdOf(args);
			if (tool === SUBMIT_STORE_CHOICE_TOOL) {
				if (!support.apps || !awaitingWidget.has(cwd)) return UNAVAILABLE;
				awaitingWidget.delete(cwd);
				return record(cwd, args);
			}
			const reselect = callArgs.parse(args).reselect === true;
			const fromLink = await collectLink(cwd);
			if (fromLink !== undefined) return fromLink;
			if (!reselect) {
				const held = options.sessions?.status(cwd);
				if (held?.established === true && held.store !== undefined)
					return sessionResult(
						{ status: "established", store: held.store },
						held.store,
					);
				let saved: StoreChoice["store"] | undefined;
				try {
					saved = await savedChoice(cwd);
				} catch {
					return NOT_SAVED;
				}
				if (saved !== undefined) {
					const established = await establish(cwd, labelFor(saved));
					return established.structuredContent?.status === "sign-in-needed" &&
						options.link !== undefined &&
						hostCannotAsk(support)
						? issueLink(cwd)
						: established;
				}
			}
			if (
				support.formElicitation &&
				request !== undefined &&
				!(health.broken() && options.link !== undefined)
			) {
				const asked = await elicitChoice(cwd, health.watch(request));
				const status = asked.structuredContent?.status;
				return (status === "cancel" || status === "decline") &&
					health.broken() &&
					options.link !== undefined
					? issueLink(cwd)
					: asked;
			}
			if (support.apps) {
				awaitingWidget.add(cwd);
				return {
					...result(
						"HoBo's store picker is shown to the owner. Their answer goes to HoBo only; it connects the store when they submit it.",
						{ status: "shown" },
					),
					_meta: { "ui/resourceUri": STORE_CHOICE_RESOURCE_URI },
				};
			}
			return issueLink(cwd);
		},
	};
}

export function renderStoreChoiceHtml(): string {
	const options = STORE_OPTIONS.map(
		(o) =>
			`<label class="opt"><input type="radio" name="store" value="${o.id}" data-label="${o.label}" required> <b>${o.label}</b> <span>${o.needs}</span></label>`,
	).join("");
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Choose your secret store</title>
<style>
:root{--ink:#111;--paper:#fff;--muted:#555;--line:#111}
:root[data-theme="dark"]{--ink:#f2f2f2;--paper:#111;--muted:#aaa;--line:#f2f2f2}
body{margin:0;padding:16px;font:15px/1.4 system-ui,sans-serif;color:var(--ink);background:var(--paper)}
h1{font-size:17px;margin:0 0 12px}.opt{display:block;padding:10px;border:2px solid var(--line);border-radius:8px;margin:0 0 8px}
.opt span{color:var(--muted);font-size:13px}.ids label{display:block;margin:8px 0 2px;font-size:13px}
input[type=text]{width:100%;box-sizing:border-box;padding:8px;border:2px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink)}
button{margin-top:12px;padding:10px 16px;border:2px solid var(--line);border-radius:8px;background:var(--ink);color:var(--paper);font-weight:600}
#say{margin-top:10px;min-height:1.2em}
</style></head><body>
<h1>Choose your secret store</h1>
<form id="f">${options}
<div class="ids">
<label for="p" data-for="infisical">Infisical project ID</label><input type="text" id="p" name="INFISICAL_PROJECT_ID" data-for="infisical">
<label for="v" data-for="1password">1Password vault ID</label><input type="text" id="v" name="OP_VAULT_ID" data-for="1password">
<label for="c" data-for="1password">Connect server (https)</label><input type="text" id="c" name="OP_CONNECT_HOST" data-for="1password">
<label for="b" data-for="bitwarden">Self-hosted server (optional)</label><input type="text" id="b" name="BITWARDEN_SERVER_URL" data-for="bitwarden">
</div>
<button type="submit">Use this store</button><div id="say" role="status"></div></form>
<script>
(function(){
var nextId=1,pending={},cwd;
function post(m){window.parent.postMessage(m,"*")}
function request(method,params){var id=nextId++;post({jsonrpc:"2.0",id:id,method:method,params:params});return new Promise(function(res,rej){pending[id]={res:res,rej:rej}})}
function notify(method,params){post({jsonrpc:"2.0",method:method,params:params})}
var f=document.getElementById("f"),say=document.getElementById("say");
function picked(){return f.querySelector("input[name=store]:checked")}
function show(){var s=(picked()||{}).value;
Array.prototype.forEach.call(document.querySelectorAll("[data-for]"),function(e){e.hidden=e.getAttribute("data-for")!==s});
notify("ui/notifications/size-changed",{height:Math.ceil(document.documentElement.scrollHeight)})}
f.addEventListener("change",show);show();
f.addEventListener("submit",function(e){e.preventDefault();var d=new FormData(f),args={},label=(picked()||{getAttribute:function(){return ""}}).getAttribute("data-label");
if(cwd)args.cwd=cwd;
d.forEach(function(v,k){var t=String(v).trim();var el=f.elements[k];if(t&&(!el||!el.hidden))args[k]=t});
request("tools/call",{name:"${SUBMIT_STORE_CHOICE_TOOL}",arguments:args}).then(function(r){
var t=(r&&r.content&&r.content[0]&&r.content[0].text)||"";say.textContent=t;
var status=(r&&r.structuredContent&&r.structuredContent.status)||"";
if(r&&!r.isError)notify("ui/message",{role:"user",content:[{type:"text",text:"I chose "+label+" as the secret store ("+status+")."}]})},
function(){say.textContent="Not recorded: the request did not complete. Try again."})});
window.addEventListener("message",function(ev){if(ev.source!==window.parent)return;var m=ev.data;if(!m||m.jsonrpc!=="2.0")return;
if(m.method===undefined&&m.id!==undefined){var w=pending[m.id];if(!w)return;delete pending[m.id];m.error?w.rej(m.error):w.res(m.result);return}
if(m.method==="ui/notifications/tool-input"&&m.params&&m.params.arguments&&typeof m.params.arguments.cwd==="string")cwd=m.params.arguments.cwd;
if(m.method==="ui/notifications/host-context-changed"&&m.params&&m.params.theme)document.documentElement.setAttribute("data-theme",m.params.theme);
if(m.id!==undefined&&(m.method==="ui/resource-teardown"||m.method==="ping"))post({jsonrpc:"2.0",id:m.id,result:{}})});
request("ui/initialize",{appInfo:{name:"hobo-store-choice",version:"1.0.0"},appCapabilities:{},protocolVersion:"2026-01-26"}).then(function(r){
if(r&&r.hostContext&&r.hostContext.theme)document.documentElement.setAttribute("data-theme",r.hostContext.theme);notify("ui/notifications/initialized",{});show()})
})();
</script></body></html>`;
}
