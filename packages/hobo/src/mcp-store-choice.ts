import type { SettingsStore } from "@hobo/connect-ui";
import {
	parseHttpsOrigin,
	parseOnePasswordVaultId,
	SettingParseError,
} from "@hobo/hobo-ci";
import { z } from "zod";

import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

// public-contract: the MCP tool that asks the owner to choose their secret store.
export const CHOOSE_SECRET_STORE_TOOL = "choose_secret_store";
// public-contract: the legacy MCP tool for recording a store choice.
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

/** Send a request to the client and wait for its answer (elicitation). */
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

const familyArg: JsonObject = {
	family: {
		type: "string",
		enum: ["ci", "cd"],
		description:
			"Which lifecycle the choice is for (hobo ci up or hobo cd up).",
	},
	cwd: {
		type: "string",
		description:
			"The project directory; the server's working directory by default.",
	},
};

export function createStoreChoiceApp(
	_options: {
		readonly cwd?: string;
		readonly locatorFor?: (cwd: string) => SettingsStore;
	} = {},
): StoreChoiceApp {
	return {
		handles: (tool) => STORE_CHOICE_TOOL_NAMES.includes(tool),
		tools() {
			return [
				{
					name: CHOOSE_SECRET_STORE_TOOL,
					title: "Check store selection availability",
					description:
						"Check whether a private HoBo owner store-selection ceremony is available.",
					inputSchema: {
						type: "object",
						properties: familyArg,
						additionalProperties: false,
					},
				},
			];
		},
		resources: () => [],
		readResource: () => undefined,
		async callTool() {
			return result(
				"Store selection cannot continue in this HoBo session until a verified private owner hand-off is available. Retry the HoBo setup ceremony once it is available.",
				{
					status: "secure-form-unavailable",
					reason: "owner-channel-unverified",
				},
				true,
			);
		},
	};
}
