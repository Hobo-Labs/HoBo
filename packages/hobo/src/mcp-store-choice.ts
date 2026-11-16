import type { SettingsStore } from "@hobo/connect-ui";
import {
	ownerLocator,
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

/**
 * The secret-store choice as an MCP experience, not a question in prose.
 *
 * A handed-off `hobo ci|cd up` stops with `HOBO_*_STORE_CHOICE` until the
 * owner chooses Infisical, 1Password or Bitwarden. The agent calls
 * `choose_secret_store`, and the owner answers in whatever the host renders:
 *
 * - **form elicitation** (`elicitation/create`, MCP 2025-06-18) where the
 *   client declared `capabilities.elicitation`: a picker of the three stores
 *   and the store's non-secret ids. Form elicitation must never ask for a
 *   secret, and this one does not: every sign-in is asked for separately,
 *   through the session's credential form;
 * - an **MCP App widget** (`ui://hobo/store-choice`) where the host renders
 *   MCP Apps: the same picker, which records the choice with
 *   `submit_store_choice`;
 * - otherwise, the agent's own picker (`AskUserQuestion`), whose answer the
 *   agent records with `submit_store_choice`.
 *
 * The answer is parsed where it enters and written to the owner's locator in
 * their HoBo settings, never the repository; the next run reads it.
 */

// public-contract: the MCP tool that asks the owner to choose their secret store.
export const CHOOSE_SECRET_STORE_TOOL = "choose_secret_store";
// public-contract: the MCP tool that records the owner's choice (widget or host picker).
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

const storeOnly = z.object({
	store: z.enum(["infisical", "1password", "bitwarden"]),
});

const elicitResult = z.object({
	action: z.enum(["accept", "decline", "cancel"]),
	content: z.unknown().optional(),
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
	options: {
		readonly cwd?: string;
		/** Where a project's choice is kept; the owner's HoBo settings by default. */
		readonly locatorFor?: (cwd: string) => SettingsStore;
	} = {},
): StoreChoiceApp {
	const locatorFor =
		options.locatorFor ?? ((cwd: string) => ownerLocator({ cwd }));
	const record = async (
		cwd: string,
		family: string,
		answer: JsonValue | undefined,
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
		const locator = locatorFor(cwd);
		await locator.write({ ...(await locator.read()), ...settings });
		const label =
			STORE_OPTIONS.find((o) => o.id === choice.store)?.label ?? choice.store;
		return result(
			`The owner chose ${label}; it is saved in their HoBo settings. Run hobo ${family} up --hand-off again: it asks for the store's sign-in itself.`,
			{ status: "chosen", ...settings },
		);
	};

	return {
		handles: (tool) => STORE_CHOICE_TOOL_NAMES.includes(tool),
		tools(support) {
			return [
				{
					name: CHOOSE_SECRET_STORE_TOOL,
					title: "Choose your secret store",
					description:
						"Ask the owner which secret store HoBo uses (Infisical, 1Password or Bitwarden) when hobo ci|cd up stops with HOBO_*_STORE_CHOICE. Shows a picker (elicitation or MCP App); never asks for a secret.",
					inputSchema: {
						type: "object",
						properties: familyArg,
						required: ["family"],
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
				},
				{
					name: SUBMIT_STORE_CHOICE_TOOL,
					title: "Record the store choice",
					description:
						"Record the owner's answer from the store picker (the MCP App, or the host's own picker). Non-secret ids only.",
					inputSchema: {
						type: "object",
						properties: { ...familyArg, ...STORE_CHOICE_PROPERTIES },
						required: ["family", "store"],
						additionalProperties: false,
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
			const cwd =
				isJsonString(args.cwd) && args.cwd.trim() !== ""
					? args.cwd
					: (options.cwd ?? process.cwd());
			const family = args.family === "ci" ? "ci" : "cd";
			if (tool === SUBMIT_STORE_CHOICE_TOOL) return record(cwd, family, args);
			if (support.formElicitation && request !== undefined) {
				const unanswered = (action: string) =>
					result(
						`The owner ${action === "decline" ? "declined" : "closed"} the store picker; nothing was recorded. Ask again with ${CHOOSE_SECRET_STORE_TOOL} when they are ready.`,
						{ status: action },
					);
				// First the store, alone.
				const first = elicitResult.safeParse(
					await request("elicitation/create", {
						message: `Choose where HoBo keeps this project's secrets (hobo ${family} up). Its sign-in is asked for separately, in the session's credential form.`,
						requestedSchema: STORE_CHOICE_SCHEMA,
					}),
				);
				if (!first.success || first.data.action !== "accept")
					return unanswered(first.success ? first.data.action : "unanswered");
				const picked = storeOnly.safeParse(first.data.content);
				if (!picked.success) return record(cwd, family, undefined);
				const store = picked.data.store;
				const label = STORE_OPTIONS.find((o) => o.id === store)?.label ?? store;
				// Then only that store's own fields.
				const second = elicitResult.safeParse(
					await request("elicitation/create", {
						message: `${label}: ${STORE_OPTIONS.find((o) => o.id === store)?.needs ?? ""}.`,
						requestedSchema: storeFieldsSchema(store),
					}),
				);
				if (!second.success || second.data.action !== "accept")
					return unanswered(second.success ? second.data.action : "unanswered");
				const fields = second.data.content;
				return record(
					cwd,
					family,
					isJsonObject(fields) ? { ...fields, store } : { store },
				);
			}
			if (support.apps)
				return {
					...result(
						"The store picker is shown to the owner. Their choice is recorded when they submit it; then run the lifecycle again.",
						{ status: "shown", family },
					),
					_meta: { "ui/resourceUri": STORE_CHOICE_RESOURCE_URI },
				};
			return result(
				`This host renders neither MCP elicitation nor MCP Apps. Ask the owner with your host's own picker (AskUserQuestion), never in prose. Ask the store alone first: ${STORE_OPTIONS.map((o) => `${o.label} (${o.needs})`).join("; ")}. Then ask only the chosen store's own follow-up, never about the others, and record the answer with ${SUBMIT_STORE_CHOICE_TOOL}.`,
				{
					status: "use-host-picker",
					options: STORE_OPTIONS.map((o) => o.label),
				},
			);
		},
	};
}

/** The MCP App: three stores, their non-secret ids, one submit. No network. */
export function renderStoreChoiceHtml(): string {
	const options = STORE_OPTIONS.map(
		(o) =>
			`<label class="opt"><input type="radio" name="store" value="${o.id}" required> <b>${o.label}</b> <span>${o.needs}</span></label>`,
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
var nextId=1,pending={},family="cd";
function post(m){window.parent.postMessage(m,"*")}
function request(method,params){var id=nextId++;post({jsonrpc:"2.0",id:id,method:method,params:params});return new Promise(function(res,rej){pending[id]={res:res,rej:rej}})}
function notify(method,params){post({jsonrpc:"2.0",method:method,params:params})}
var f=document.getElementById("f"),say=document.getElementById("say");
function show(){var s=(f.querySelector("input[name=store]:checked")||{}).value;
Array.prototype.forEach.call(document.querySelectorAll("[data-for]"),function(e){e.hidden=e.getAttribute("data-for")!==s});
notify("ui/notifications/size-changed",{height:Math.ceil(document.documentElement.scrollHeight)})}
f.addEventListener("change",show);show();
f.addEventListener("submit",function(e){e.preventDefault();var d=new FormData(f),args={family:family};
d.forEach(function(v,k){var t=String(v).trim();var el=f.elements[k];if(t&&(!el||!el.hidden))args[k]=t});
request("tools/call",{name:"${SUBMIT_STORE_CHOICE_TOOL}",arguments:args}).then(function(r){
var t=(r&&r.content&&r.content[0]&&r.content[0].text)||"";say.textContent=t;
if(r&&!r.isError)notify("ui/message",{role:"user",content:[{type:"text",text:"I chose "+args.store+" as the secret store."}]})},
function(){say.textContent="Not recorded: the request did not complete. Try again."})});
window.addEventListener("message",function(ev){if(ev.source!==window.parent)return;var m=ev.data;if(!m||m.jsonrpc!=="2.0")return;
if(m.method===undefined&&m.id!==undefined){var w=pending[m.id];if(!w)return;delete pending[m.id];m.error?w.rej(m.error):w.res(m.result);return}
if(m.method==="ui/notifications/tool-input"&&m.params&&m.params.arguments&&m.params.arguments.family)family=m.params.arguments.family;
if(m.method==="ui/notifications/host-context-changed"&&m.params&&m.params.theme)document.documentElement.setAttribute("data-theme",m.params.theme);
if(m.id!==undefined&&(m.method==="ui/resource-teardown"||m.method==="ping"))post({jsonrpc:"2.0",id:m.id,result:{}})});
request("ui/initialize",{appInfo:{name:"hobo-store-choice",version:"1.0.0"},appCapabilities:{},protocolVersion:"2026-01-26"}).then(function(r){
if(r&&r.hostContext&&r.hostContext.theme)document.documentElement.setAttribute("data-theme",r.hostContext.theme);notify("ui/notifications/initialized",{});show()})
})();
</script></body></html>`;
}
