import path from "node:path";

import type { HttpsOrigin } from "@hobo/hobo-ci";
import { z } from "zod";

import type { JsonObject } from "./json.js";
import {
	OWNER_PAGE_COLLECTION,
	OwnerPageRefused,
	type OwnerPages,
	renderRelayConfirmationHtml,
} from "./mcp-owner-page.js";
import type {
	CallToolResult,
	ClientRequest,
	StoreChoiceToolDefinition,
} from "./mcp-store-choice.js";
import {
	parseRelayOrigin,
	type RelayConfirmation,
	type RelayLoginError,
	type RelayOwnerSessions,
} from "./relay-owner-session.js";

// public-contract: the MCP tool that signs this HoBo server in to the owner's already configured CI relay.
export const RELAY_LOGIN_TOOL = "relay_login";

type ToolResult = CallToolResult;

const relayArgs = z
	.object({
		cwd: z.string().trim().min(1).optional().catch(undefined),
		sealed: z.string().min(1).optional().catch(undefined),
	})
	.loose();

const elicited = z.object({
	action: z.enum(["accept", "decline", "cancel"]),
	content: z
		.object({ relay: z.string().max(2048) })
		.loose()
		.optional(),
});

function result(
	message: string,
	structured: JsonObject,
	isError = false,
): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		structuredContent: structured,
		...(isError ? { isError: true } : undefined),
	};
}

const established = (expiresInSeconds: number) =>
	result(
		"HoBo is signed in to the owner's HoBo CI relay for this server's lifetime. hobo ci and hobo cd verbs resolve owner://HOBO_CI_ACCOUNT_TOKEN and github-app://<owner>/<repo> through it; nothing is returned to you and nothing is stored on this machine.",
		{ status: "established", expiresInSeconds },
	);

const PENDING = result(
	"The owner has the GitHub confirmation in front of them; HoBo is waiting for it. Call relay_login again once they say they confirmed.",
	{ status: "pending" },
);

function failed(error: RelayLoginError): ToolResult {
	return result(
		`${error.message} Nothing was stored. ${error.remediation.join(" ")}`,
		{ status: "failed", code: error.code },
		true,
	);
}

const UNAVAILABLE = result(
	"This host shows neither MCP forms nor HoBo's owner page, so HoBo cannot ask the owner for their relay privately. Nothing was collected. Do not ask the owner for the relay address in chat.",
	{ status: "secure-form-unavailable", reason: "no-private-owner-form" },
	true,
);

export const RELAY_LOGIN_DEFINITION: StoreChoiceToolDefinition = {
	name: RELAY_LOGIN_TOOL,
	title: "Sign in to the owner's HoBo CI relay",
	description:
		"Reconnect HoBo to the owner's already configured HoBo CI relay with one GitHub confirmation, instead of the store setup form. The owner gives the relay address privately (a host form or HoBo's owner page) and confirms a code at GitHub; the session lives only in this server's memory. Pass `sealed` only with the text the owner page saved. Returns a status, never the address, code or session.",
	inputSchema: {
		type: "object",
		properties: {
			cwd: {
				type: "string",
				description:
					"The project directory; the server's working directory by default.",
			},
			sealed: {
				type: "string",
				description:
					"The `sealed` text HoBo's relay owner page saved, unchanged.",
			},
		},
		additionalProperties: false,
	},
};

export interface RelayLoginTool {
	call(
		args: JsonObject,
		support: Readonly<{ formElicitation: boolean }>,
		request: ClientRequest | undefined,
	): Promise<ToolResult>;
}

export function createRelayLoginTool(options: {
	readonly relay: RelayOwnerSessions;
	readonly pages?: OwnerPages;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly waitMs?: number;
	readonly cwd?: string;
}): RelayLoginTool {
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const waitMs = options.waitMs ?? 120_000;

	const settled = async (grant: Promise<unknown>) => {
		const outcome = await Promise.race([
			grant.then(
				() => "done" as const,
				() => "failed" as const,
			),
			sleep(waitMs).then(() => "waiting" as const),
		]);
		const state = options.relay.state();
		if (outcome === "done" && state.status === "established")
			return established(state.expiresInSeconds);
		if (state.status === "failed") return failed(state.error);
		return PENDING;
	};

	const withForm = async (
		origin: HttpsOrigin,
		request: ClientRequest,
	): Promise<ToolResult> => {
		const grant = options.relay.begin({
			origin,
			present: async (confirmation) => {
				void request("elicitation/create", {
					mode: "form",
					message: `Open ${confirmation.verificationUri}, sign in as the owner of HoBo's GitHub App installation, and enter the code ${confirmation.userCode}. Then choose Done. HoBo keeps this session only in memory.`,
					requestedSchema: {
						type: "object",
						properties: {
							confirmed: {
								type: "boolean",
								title: "I entered the code at GitHub",
							},
						},
					},
				}).catch(() => undefined);
			},
		});
		grant.catch(() => undefined);
		return settled(grant);
	};

	const withPage = async (origin: HttpsOrigin): Promise<ToolResult> => {
		let shown: (confirmation: RelayConfirmation) => void = () => undefined;
		const presented = new Promise<RelayConfirmation>((resolve) => {
			shown = resolve;
		});
		const grant = options.relay.begin({
			origin,
			present: async (confirmation) => shown(confirmation),
		});
		grant.catch(() => undefined);
		const first = await Promise.race([
			presented,
			grant.then(
				() => undefined,
				() => undefined,
			),
		]);
		if (first === undefined) {
			const state = options.relay.state();
			return state.status === "failed" ? failed(state.error) : PENDING;
		}
		return result(
			[
				"HoBo started the GitHub confirmation. Publish structuredContent.html unchanged as an Artifact and show it to the owner; it holds the link and the one-time code, which are for the owner only: do not repeat them in chat.",
				"When the owner says GitHub confirmed the device, call relay_login again.",
			].join("\n"),
			{
				status: "confirm-page",
				html: renderRelayConfirmationHtml(first),
			},
		);
	};

	return {
		async call(args, support, request) {
			const parsed = relayArgs.parse(args);
			const cwd = path.resolve(parsed.cwd ?? options.cwd ?? process.cwd());
			const state = options.relay.state();
			if (parsed.sealed === undefined) {
				if (state.status === "established")
					return established(state.expiresInSeconds);
				if (state.status === "pending") return PENDING;
			}
			if (parsed.sealed !== undefined) {
				if (options.pages === undefined) return UNAVAILABLE;
				let origin: HttpsOrigin;
				try {
					origin = (await options.pages.unsealRelay(parsed.sealed)).origin;
				} catch (error) {
					if (!(error instanceof OwnerPageRefused)) throw error;
					return result(
						`HoBo could not open the page's answer (${error.reason}); nothing was used. Call relay_login for a new page.`,
						{ status: "refused", reason: error.reason },
						true,
					);
				}
				return withPage(origin);
			}
			if (support.formElicitation && request !== undefined) {
				const answer = elicited.safeParse(
					await request("elicitation/create", {
						mode: "form",
						message:
							"Sign HoBo in to your already configured HoBo CI relay. Only HoBo reads the address; it is kept in this session's memory and never stored or shown to the agent.",
						requestedSchema: {
							type: "object",
							properties: {
								relay: {
									type: "string",
									title: "Relay address (https)",
									format: "uri",
								},
							},
							required: ["relay"],
						},
					}),
				);
				if (
					!answer.success ||
					answer.data.action !== "accept" ||
					answer.data.content === undefined
				)
					return result(
						"The owner closed the relay sign-in; nothing was collected. Call relay_login again when they are ready.",
						{ status: "cancel" },
					);
				let origin: HttpsOrigin;
				try {
					origin = parseRelayOrigin(answer.data.content.relay);
				} catch {
					return result(
						"The address the owner gave is not an https origin; nothing was used. Call relay_login again.",
						{ status: "invalid", rule: "https-origin" },
						true,
					);
				}
				return withForm(origin, request);
			}
			if (options.pages === undefined) return UNAVAILABLE;
			const opened = await options.pages.openRelay(cwd);
			return result(
				[
					"This host shows no MCP forms, so HoBo made its own owner page for the relay address.",
					`1. Publish structuredContent.html unchanged as an Artifact with capabilities {"db":{}} and show it to the owner. Its key fingerprint is ${opened.fingerprint}.`,
					"2. Wait until the owner says they sent it.",
					`3. Read the document ${OWNER_PAGE_COLLECTION}/${opened.page} from that artifact's database and call ${RELAY_LOGIN_TOOL} with its "sealed" field, unchanged.`,
					"The answer is encrypted to this HoBo server; you carry it but cannot read it. Do not ask the owner for the relay address in chat.",
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
		},
	};
}
