import { randomUUID } from "node:crypto";
import path from "node:path";

import {
	isOwnerStoreSetting,
	type OwnerSettingsStore,
	parseHttpsOrigin,
	parseOnePasswordVaultId,
	SettingParseError,
} from "@hobo/hobo-ci";
import { z } from "zod";

import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	STORE_OWNER_ENTRIES_DESCRIPTION,
	STORE_OWNER_ENTRIES_INPUT,
	STORE_OWNER_ENTRIES_TITLE,
	STORE_OWNER_ENTRIES_TOOL,
	storeOwnerEntries,
} from "./mcp-owner-entries.js";
import {
	type OpenedOwnerPage,
	OWNER_PAGE_COLLECTION,
	OWNER_PAGE_SECRET_FIELDS,
	OwnerPageRefused,
	type OwnerPages,
} from "./mcp-owner-page.js";
import {
	RELAY_LOGIN_DEFINITION,
	RELAY_LOGIN_TOOL,
	type RelayLoginTool,
} from "./mcp-relay-login.js";
import type {
	OwnerPageSignIn,
	OwnerSessionState,
	OwnerStoreLabel,
	OwnerStoreSessions,
} from "./owner-store-session.js";
import { OwnerWriteGuardUnavailableError } from "./owner-write-guard.js";

// public-contract: the MCP tool that asks the owner to choose their secret store.
export const CHOOSE_SECRET_STORE_TOOL = "choose_secret_store";
// public-contract: the MCP App-only tool that records the owner's store choice from the picker widget.
export const SUBMIT_STORE_CHOICE_TOOL = "submit_store_choice";
// public-contract: the MCP tool that takes the sealed answer of HoBo's owner page.
export const SUBMIT_OWNER_PAGE_TOOL = "submit_owner_page";
// public-contract: the MCP App resource of the store picker.
export const STORE_CHOICE_RESOURCE_URI = "ui://hobo/store-choice";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

export const STORE_CHOICE_TOOL_NAMES: readonly string[] = Object.freeze([
	CHOOSE_SECRET_STORE_TOOL,
	SUBMIT_STORE_CHOICE_TOOL,
	SUBMIT_OWNER_PAGE_TOOL,
	STORE_OWNER_ENTRIES_TOOL,
	RELAY_LOGIN_TOOL,
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
		needs: "nothing to look up; HoBo finds or creates its project",
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

const STORE_FIELD: JsonObject = {
	type: "string",
	title: "Secret store",
	description:
		"Where HoBo keeps this project's credentials. Its sign-in is asked for separately, never here.",
	oneOf: STORE_OPTIONS.map((o) => ({ const: o.id, title: o.label })),
};

const STORE_CHOICE_FIELD_NAMES = [
	"INFISICAL_PROJECT_ID",
	"OP_VAULT_ID",
	"OP_CONNECT_HOST",
	"BITWARDEN_SERVER_URL",
] as const;

type StoreFieldName = (typeof STORE_CHOICE_FIELD_NAMES)[number];

const STORE_FIELDS = {
	INFISICAL_PROJECT_ID: {
		type: "string",
		title: "Infisical project ID (optional; HoBo finds or creates its project)",
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
} satisfies Readonly<Record<StoreFieldName, JsonObject>>;

export const STORE_CHOICE_PROPERTIES: JsonObject = {
	store: STORE_FIELD,
	...STORE_FIELDS,
};

/**
 * The first form: the store alone. A store's own fields come in a second
 * form, after the owner chose it, so no one is asked about a store they did
 * not choose.
 */
export const STORE_CHOICE_SCHEMA: JsonObject = {
	type: "object",
	properties: { store: STORE_FIELD },
	required: ["store"],
};

/** The second form: only the chosen store's non-secret fields. */
export function storeFieldsSchema(
	store: "infisical" | "1password" | "bitwarden",
): JsonObject {
	const pick = (names: readonly StoreFieldName[]): JsonObject =>
		Object.fromEntries(names.map((name) => [name, STORE_FIELDS[name]]));
	switch (store) {
		case "infisical":
			return {
				type: "object",
				properties: pick(["INFISICAL_PROJECT_ID"]),
				required: [],
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
	| { readonly store: "infisical"; readonly projectId: string | undefined }
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
				...(choice.projectId !== undefined
					? { INFISICAL_PROJECT_ID: choice.projectId }
					: undefined),
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
		channel: z.enum(["form", "page"]).optional().catch(undefined),
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

const entriesDefinition: StoreChoiceToolDefinition = {
	name: STORE_OWNER_ENTRIES_TOOL,
	title: STORE_OWNER_ENTRIES_TITLE,
	description: STORE_OWNER_ENTRIES_DESCRIPTION,
	inputSchema: STORE_OWNER_ENTRIES_INPUT,
};

const sealedArg = z.object({ sealed: z.string().min(1) });

function ownerPage(opened: OpenedOwnerPage): CallToolResult {
	return result(
		[
			"This host shows neither MCP forms nor MCP Apps, so HoBo made its own owner page.",
			`1. Publish structuredContent.html unchanged as an Artifact with capabilities {"db":{}} and show it to the owner. Its key fingerprint is ${opened.fingerprint}.`,
			"2. Wait until the owner says they sent it.",
			`3. Read the document ${OWNER_PAGE_COLLECTION}/${opened.page} from that artifact's database and call ${SUBMIT_OWNER_PAGE_TOOL} with its "sealed" field, unchanged.`,
			"The answer is encrypted to this HoBo server; you carry it but cannot read it. Do not ask the owner for any of it in chat.",
		].join("\n"),
		{
			status: "owner-page",
			page: opened.page,
			fingerprint: opened.fingerprint,
			document: `${OWNER_PAGE_COLLECTION}/${opened.page}`,
			capabilities: { db: {} },
			html: opened.html,
		},
	);
}

const UNAVAILABLE = result(
	"This host renders neither MCP form elicitation nor MCP Apps, so HoBo cannot ask the owner privately. Nothing was collected or saved. Report that this host cannot provide a secure HoBo owner hand-off; do not ask for store coordinates in conversation.",
	{
		status: "secure-form-unavailable",
		reason: "no-private-owner-form",
		options: STORE_OPTIONS.map((o) => o.label),
	},
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
	family: "ci" | "cd",
	recorded = false,
): CallToolResult {
	if (state === undefined)
		return result(
			`The owner chose ${label}; it is saved in their own HoBo settings. This server holds no store session. Run hobo ${family} up --hand-off again: it asks for the store's sign-in itself.`,
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
				`The owner chose ${state.store}, and its sign-in has not completed (${state.code}${state.reason === undefined ? "" : `: ${state.reason}`}). Call choose_secret_store again when the owner is ready; their choice is kept.`,
				{
					status: "sign-in-needed",
					store: state.store,
					code: state.code,
					...(state.reason === undefined
						? undefined
						: { reason: state.reason }),
				},
				!recorded,
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
	channel: {
		type: "string",
		enum: ["form", "page"],
		description:
			"page: HoBo's sealed owner page (an Artifact), also for the store's sign-in; use it when the host declares forms but the owner never sees them.",
	},
};

export function createStoreChoiceApp(
	options: {
		readonly cwd?: string;
		readonly locatorFor?: (
			cwd: string,
			family: "ci" | "cd",
		) => OwnerSettingsStore;
		readonly sessions?: OwnerStoreSessions;
		readonly pages?: OwnerPages;
		readonly relayLogin?: RelayLoginTool;
	} = {},
): StoreChoiceApp {
	const locatorFor = options.locatorFor;
	const ownerSetupUnavailable = () =>
		result(
			"Private owner store selection is not available in this HoBo MCP session. This tool cannot establish an owner store session.",
			{
				status: "secure-form-unavailable",
				reason: "owner-setup-unavailable",
			},
			true,
		);
	const verifiedLocator = (
		cwd: string,
		family: "ci" | "cd",
	): OwnerSettingsStore | undefined => {
		if (locatorFor === undefined) return undefined;
		try {
			const locator = locatorFor(cwd, family);
			if (
				locator.assertCurrent === undefined ||
				locator.onOwnerChoice === undefined ||
				locator.selectionRevision === undefined
			)
				return undefined;
			locator.assertCurrent();
			return locator;
		} catch {
			return undefined;
		}
	};
	type ChoiceTicket = {
		cwd: string;
		family: "ci" | "cd";
		key: string;
		revision: number;
		locator: OwnerSettingsStore;
		expires: number;
	};
	const revisions = new Map<string, number>();
	const tickets = new Map<string, ChoiceTicket>();
	const pageTickets = new Map<string, ChoiceTicket>();
	const cwdOf = (args: JsonObject) =>
		path.resolve(callArgs.parse(args).cwd ?? options.cwd ?? process.cwd());
	const stale = () =>
		result(
			"This store picker is no longer current. Open a new picker for the selected project.",
			{ status: "stale" },
			true,
		);

	const establish = async (
		cwd: string,
		label: OwnerStoreLabel,
		family: "ci" | "cd",
		recorded = false,
		signIn?: OwnerPageSignIn,
	) => {
		const state =
			family === "ci"
				? await options.sessions?.establish(cwd, signIn, family)
				: signIn === undefined
					? await options.sessions?.establish(cwd)
					: await options.sessions?.establish(cwd, signIn);
		return sessionResult(state, label, family, recorded);
	};

	const record = async (
		ticket: ChoiceTicket,
		answer: JsonValue | undefined,
		signIn?: OwnerPageSignIn,
	): Promise<CallToolResult> => {
		let choice: StoreChoice;
		try {
			choice = parseStoreChoice(answer);
		} catch (error) {
			if (!(error instanceof StoreChoiceInvalid)) throw error;
			return result(
				`Not recorded: ${error.rule} Ask the owner again with ${CHOOSE_SECRET_STORE_TOOL}.`,
				{ status: "invalid", rule: error.rule },
				true,
			);
		}
		const settings = locatorSettings(choice);
		let previous: Readonly<Record<string, string>>;
		try {
			if (
				(revisions.get(ticket.key) ?? 0) !== ticket.revision ||
				Date.now() >= ticket.expires
			)
				return stale();
			ticket.locator.assertCurrent?.();
			previous = await ticket.locator.read();
			if (
				(revisions.get(ticket.key) ?? 0) !== ticket.revision ||
				Date.now() >= ticket.expires
			)
				return stale();
			ticket.locator.assertCurrent?.();
			ticket.locator.onOwnerChoice?.();
			options.sessions?.invalidate?.(ticket.cwd, ticket.family);
			revisions.set(ticket.key, ticket.revision + 1);
		} catch (error) {
			if (error instanceof OwnerWriteGuardUnavailableError)
				return result(
					"Store changes are unavailable on this HoBo host. Existing connections can still be used read-only. Check the host's storage and permissions, or use a supported host.",
					{ status: "write-guard-unavailable" },
					true,
				);
			if (ticket.locator.hasPendingWrites?.())
				return result(
					"The selected store is saving a change. Wait until it finishes, then open the picker again.",
					{ status: "busy" },
					true,
				);
			return stale();
		}
		try {
			const current = locatorFor?.(ticket.cwd, ticket.family) ?? ticket.locator;
			await current.write({
				...Object.fromEntries(
					Object.entries(previous).filter(
						([name]) => !isOwnerStoreSetting(name),
					),
				),
				...settings,
			});
		} catch {
			return NOT_SAVED;
		}
		return establish(
			ticket.cwd,
			labelFor(choice.store),
			ticket.family,
			true,
			signIn,
		);
	};

	const savedChoice = async (locator: OwnerSettingsStore) => {
		const saved = chosenStore.safeParse(await locator.read());
		return saved.success ? saved.data.HOBO_SECRET_STORE : undefined;
	};

	const elicitChoice = async (
		ticket: ChoiceTicket,
		request: ClientRequest,
	): Promise<CallToolResult> => {
		const unanswered = (action: string) =>
			result(
				`The owner ${action === "decline" ? "declined" : "closed"} the store picker; nothing was recorded. Ask again with ${CHOOSE_SECRET_STORE_TOOL} when they are ready.`,
				{ status: action === "decline" ? "decline" : "cancel" },
			);
		const first = elicitResult.safeParse(
			await request("elicitation/create", {
				mode: "form",
				message: `Choose where HoBo keeps this project's credentials (hobo ${ticket.family} up). Its sign-in is asked for separately; nothing you enter here is shown to the agent.`,
				requestedSchema: STORE_CHOICE_SCHEMA,
			}),
		);
		if (!first.success || first.data.action !== "accept")
			return unanswered(first.success ? first.data.action : "cancel");
		const picked = storeOnly.safeParse(first.data.content);
		if (!picked.success) return record(ticket, undefined);
		const store = picked.data.store;
		const option = STORE_OPTIONS.find((o) => o.id === store);
		const second = elicitResult.safeParse(
			await request("elicitation/create", {
				mode: "form",
				message: `${option?.label ?? store}: ${option?.needs ?? ""}. Only HoBo reads this.`,
				requestedSchema: storeFieldsSchema(store),
			}),
		);
		if (!second.success || second.data.action !== "accept")
			return unanswered(second.success ? second.data.action : "cancel");
		const fields = second.data.content;
		return record(
			ticket,
			isJsonObject(fields) ? { ...fields, store } : { store },
		);
	};

	const submitOwnerPage = async (
		args: JsonObject,
		pages: OwnerPages,
	): Promise<CallToolResult> => {
		const sealed = sealedArg.safeParse(args);
		if (!sealed.success)
			return result(
				"Pass the page's `sealed` text exactly as the artifact database holds it.",
				{ status: "invalid", rule: "sealed-missing" },
				true,
			);
		let opened: Awaited<ReturnType<OwnerPages["unseal"]>>;
		try {
			opened = await pages.unseal(sealed.data.sealed);
		} catch (error) {
			if (!(error instanceof OwnerPageRefused)) throw error;
			return result(
				`HoBo could not open the page's answer (${error.reason}); nothing was recorded. Call choose_secret_store for a new page.`,
				{ status: "refused", reason: error.reason },
				true,
			);
		}
		const ticket = pageTickets.get(opened.page);
		pageTickets.delete(opened.page);
		if (ticket === undefined || ticket.cwd !== opened.cwd)
			return ownerSetupUnavailable();
		if (
			(revisions.get(ticket.key) ?? 0) !== ticket.revision ||
			Date.now() >= ticket.expires
		)
			return stale();
		const { answers } = opened;
		const allowed = {
			infisical: ["INFISICAL_CLI_SESSION", "INFISICAL_TOKEN"],
			"1password": ["OP_CONNECT_TOKEN"],
			bitwarden: ["BW_CLIENTID", "BW_CLIENTSECRET"],
		} as const;
		const names: readonly string[] = allowed[answers.store];
		const signIn: Record<string, string> = {};
		for (const name of OWNER_PAGE_SECRET_FIELDS) {
			const value = answers[name]?.trim();
			if (names.includes(name) && value !== undefined && value !== "")
				signIn[name] = value;
		}
		const choice: JsonObject = Object.fromEntries([
			["store", answers.store],
			...STORE_CHOICE_FIELD_NAMES.flatMap((name) => {
				const value = answers[name];
				return value === undefined ? [] : [[name, value]];
			}),
		]);
		return record(ticket, choice, signIn);
	};

	const openPage = async (
		ticket: ChoiceTicket,
		pages: OwnerPages,
	): Promise<CallToolResult> => {
		const opened = await pages.open(ticket.cwd);
		for (const [page, pending] of pageTickets)
			if (pending.expires <= Date.now()) pageTickets.delete(page);
		if (pageTickets.size >= 32)
			pageTickets.delete(pageTickets.keys().next().value ?? "");
		pageTickets.set(opened.page, ticket);
		return ownerPage(opened);
	};

	const baseTools = (
		support: StoreChoiceSupport,
		owned: boolean,
	): readonly StoreChoiceToolDefinition[] => {
		const choose: StoreChoiceToolDefinition = {
			name: CHOOSE_SECRET_STORE_TOOL,
			title: "Connect the owner's secret store",
			description:
				"Connect the owner's secret store to this HoBo session: reuse an established session, or ask the owner privately (a host form, HoBo's widget or HoBo's sealed owner page) which store to use (Infisical, 1Password or Bitwarden) and sign in, including when hobo ci|cd up stops with HOBO_*_STORE_CHOICE. Takes no store settings; returns only a status and the store's name.",
			inputSchema: {
				type: "object",
				properties: chooseArgs,
				additionalProperties: false,
			},
			...(owned && support.apps
				? {
						_meta: {
							ui: { resourceUri: STORE_CHOICE_RESOURCE_URI },
							"ui/resourceUri": STORE_CHOICE_RESOURCE_URI,
						},
					}
				: undefined),
		};
		if (!owned) return [choose];
		if (!support.apps)
			return support.formElicitation || options.pages === undefined
				? [choose]
				: [
						choose,
						{
							name: SUBMIT_OWNER_PAGE_TOOL,
							title: "Hand HoBo the owner page's sealed answer",
							description:
								"Pass the `sealed` text the owner's page saved, exactly as read from the artifact database. It is encrypted to this HoBo server; only HoBo can open it.",
							inputSchema: {
								type: "object",
								properties: {
									sealed: { type: "string" },
									cwd: {
										type: "string",
										description:
											"The project directory; the server's working directory by default.",
									},
								},
								required: ["sealed"],
								additionalProperties: false,
							},
						},
					];
		return [
			choose,
			{
				name: SUBMIT_STORE_CHOICE_TOOL,
				title: "Record the store choice",
				description:
					"Called only by HoBo's store picker widget with the owner's answer.",
				inputSchema: {
					type: "object",
					properties: {
						...familyArg,
						...STORE_CHOICE_PROPERTIES,
						choiceTicket: { type: "string" },
					},
					required: ["store", "choiceTicket"],
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
	};

	return {
		handles: (tool) => STORE_CHOICE_TOOL_NAMES.includes(tool),
		tools(support) {
			const owned = locatorFor !== undefined;
			const tools = baseTools(support, owned);
			return [
				...tools,
				...(options.sessions === undefined ? [] : [entriesDefinition]),
				...(options.relayLogin === undefined ? [] : [RELAY_LOGIN_DEFINITION]),
			];
		},
		resources(support) {
			return locatorFor !== undefined && support.apps
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
			if (uri !== STORE_CHOICE_RESOURCE_URI || locatorFor === undefined)
				return undefined;
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
			const family = args.family === "ci" ? "ci" : "cd";
			if (tool === RELAY_LOGIN_TOOL)
				return options.relayLogin === undefined
					? UNAVAILABLE
					: options.relayLogin.call(args, support, request);
			if (tool === STORE_OWNER_ENTRIES_TOOL) {
				const outcome = await storeOwnerEntries({
					cwd,
					args,
					sessions: options.sessions,
					ask:
						support.formElicitation && request !== undefined
							? (params) => request("elicitation/create", params)
							: undefined,
				});
				return result(outcome.text, outcome.structured, outcome.isError);
			}
			if (tool === SUBMIT_OWNER_PAGE_TOOL) {
				if (options.pages === undefined) return UNAVAILABLE;
				return submitOwnerPage(args, options.pages);
			}
			if (tool === SUBMIT_STORE_CHOICE_TOOL) {
				if (verifiedLocator(cwd, family) === undefined)
					return ownerSetupUnavailable();
				if (!support.apps) return UNAVAILABLE;
				const id = isJsonString(args.choiceTicket) ? args.choiceTicket : "";
				const ticket = tickets.get(id);
				if (!ticket) return UNAVAILABLE;
				if (ticket.family !== family || ticket.cwd !== cwd) return stale();
				const outcome = await record(ticket, args);
				if (!outcome.isError || outcome.structuredContent?.status === "stale")
					tickets.delete(id);
				return outcome;
			}
			const locator = verifiedLocator(cwd, family);
			if (locator === undefined) return ownerSetupUnavailable();
			const key = `${family}\u0000${cwd}`;
			const ticketFor = (minutes: number): ChoiceTicket => ({
				cwd,
				family,
				key,
				revision: revisions.get(key) ?? 0,
				locator,
				expires: Date.now() + minutes * 60_000,
			});
			const parsedCall = callArgs.parse(args);
			if (parsedCall.channel === "page" && options.pages !== undefined)
				return openPage(ticketFor(30), options.pages);
			if (
				parsedCall.reselect !== true &&
				locator.hasSessionChoice?.() !== false
			) {
				const held = options.sessions?.status(cwd, family);
				if (held?.established === true && held.store !== undefined)
					return sessionResult(
						{ status: "established", store: held.store },
						held.store,
						family,
					);
				let saved: StoreChoice["store"] | undefined;
				try {
					saved = await savedChoice(locator);
				} catch {
					return NOT_SAVED;
				}
				if (saved !== undefined) return establish(cwd, labelFor(saved), family);
			}
			const ticket = ticketFor(10);
			if (support.formElicitation && request !== undefined)
				return elicitChoice(ticket, request);
			if (support.apps) {
				for (const [id, pending] of tickets)
					if (pending.expires <= Date.now()) tickets.delete(id);
				if (tickets.size >= 32)
					tickets.delete(tickets.keys().next().value ?? "");
				const id = randomUUID();
				tickets.set(id, ticket);
				return {
					...result(
						"HoBo's store picker is shown to the owner. Their answer goes to HoBo only; it connects the store when they submit it.",
						{ status: "shown" },
					),
					_meta: {
						"ui/resourceUri": STORE_CHOICE_RESOURCE_URI,
						hoboChoiceTicket: id,
					},
				};
			}
			if (options.pages === undefined) return UNAVAILABLE;
			return openPage(ticketFor(30), options.pages);
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
[data-for][hidden]{display:none}
input[type=text]{width:100%;box-sizing:border-box;padding:8px;border:2px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink)}
button{margin-top:12px;padding:10px 16px;border:2px solid var(--line);border-radius:8px;background:var(--ink);color:var(--paper);font-weight:600}
button:disabled{opacity:.45;cursor:not-allowed}
button:not(:disabled){cursor:pointer}
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
<button type="submit" disabled>Use this store</button><div id="say" role="status"></div></form>
<script>
(function(){
var nextId=1,pending={},family="cd",cwd,choiceTicket,inputReady=false;
function post(m){window.parent.postMessage(m,"*")}
function request(method,params){var id=nextId++;post({jsonrpc:"2.0",id:id,method:method,params:params});return new Promise(function(res,rej){pending[id]={res:res,rej:rej}})}
function notify(method,params){post({jsonrpc:"2.0",method:method,params:params})}
var f=document.getElementById("f"),say=document.getElementById("say"),button=f.querySelector("button");
function ready(){button.disabled=!(inputReady&&choiceTicket)}
function picked(){return f.querySelector("input[name=store]:checked")}
function show(){var s=(picked()||{}).value;
Array.prototype.forEach.call(document.querySelectorAll("[data-for]"),function(e){e.hidden=e.getAttribute("data-for")!==s});
notify("ui/notifications/size-changed",{height:Math.ceil(document.documentElement.scrollHeight)})}
f.addEventListener("change",show);show();
f.addEventListener("submit",function(e){e.preventDefault();if(!inputReady||!choiceTicket)return;var d=new FormData(f),args={family:family,choiceTicket:choiceTicket},label=(picked()||{getAttribute:function(){return ""}}).getAttribute("data-label");
if(cwd)args.cwd=cwd;
d.forEach(function(v,k){var t=String(v).trim();var el=f.elements[k];if(t&&(!el||!el.hidden))args[k]=t});
request("tools/call",{name:"${SUBMIT_STORE_CHOICE_TOOL}",arguments:args}).then(function(r){
var t=(r&&r.content&&r.content[0]&&r.content[0].text)||"";say.textContent=t;
var status=(r&&r.structuredContent&&r.structuredContent.status)||"";
if(r&&!r.isError)notify("ui/message",{role:"user",content:[{type:"text",text:"I chose "+label+" as the secret store ("+status+")."}]})},
function(){say.textContent="Not recorded: the request did not complete. Try again."})});
window.addEventListener("message",function(ev){if(ev.source!==window.parent)return;var m=ev.data;if(!m||m.jsonrpc!=="2.0")return;
if(m.method===undefined&&m.id!==undefined){var w=pending[m.id];if(!w)return;delete pending[m.id];m.error?w.rej(m.error):w.res(m.result);return}
if(m.method==="ui/notifications/tool-input"&&m.params&&m.params.arguments){if(m.params.arguments.family)family=m.params.arguments.family;if(typeof m.params.arguments.cwd==="string")cwd=m.params.arguments.cwd;inputReady=true;ready()}
if(m.method==="ui/notifications/tool-result"&&m.params&&m.params._meta&&typeof m.params._meta.hoboChoiceTicket==="string"){choiceTicket=m.params._meta.hoboChoiceTicket;ready()}
if(m.method==="ui/notifications/host-context-changed"&&m.params&&m.params.theme)document.documentElement.setAttribute("data-theme",m.params.theme);
if(m.id!==undefined&&(m.method==="ui/resource-teardown"||m.method==="ping"))post({jsonrpc:"2.0",id:m.id,result:{}})});
request("ui/initialize",{appInfo:{name:"hobo-store-choice",version:"1.0.0"},appCapabilities:{},protocolVersion:"2026-01-26"}).then(function(r){
if(r&&r.hostContext&&r.hostContext.theme)document.documentElement.setAttribute("data-theme",r.hostContext.theme);notify("ui/notifications/initialized",{});show()})
})();
</script></body></html>`;
}
