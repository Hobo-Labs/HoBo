import { z } from "zod";

import type { JsonObject, JsonValue } from "./json.js";
import type { OwnerStoreSessions } from "./owner-store-session.js";

// public-contract: the MCP tool that asks the owner for the provider entries HoBo needs and writes them to their store.
export const STORE_OWNER_ENTRIES_TOOL = "store_owner_entries";

const KUBECONFIG_MARKER = /^\s*apiVersion:/mu;

export type OwnerEntryName =
	| "HOSTINGER_API_TOKEN"
	| "HOSTINGER_ARC_KUBECONFIG"
	| "HOBO_CI_ACCOUNT_TOKEN";

export type OwnerEntrySpec = Readonly<{
	name: OwnerEntryName;
	label: string;
	purpose: string;
	minLength: number;
	maxLength: number;
	parse: (value: string) => string | undefined;
}>;

const oneLine = (min: number) => (value: string) => {
	const trimmed = value.trim();
	return trimmed.length >= min && !/\s/u.test(trimmed) ? trimmed : undefined;
};

function kubeconfig(value: string): string | undefined {
	const trimmed = value.trim();
	if (KUBECONFIG_MARKER.test(trimmed)) return `${trimmed}\n`;
	if (!/^[A-Za-z0-9+/=_-]+$/u.test(trimmed)) return undefined;
	const decoded = Buffer.from(trimmed, "base64").toString("utf8");
	return KUBECONFIG_MARKER.test(decoded) ? decoded : undefined;
}

export const OWNER_ENTRY_SPECS: readonly OwnerEntrySpec[] = Object.freeze([
	{
		name: "HOSTINGER_API_TOKEN",
		label: "Hostinger API token",
		purpose:
			"Hostinger API token (hPanel → Profile → API). HoBo uses it for hobo ci fleet and Hostinger deploys.",
		minLength: 20,
		maxLength: 1024,
		parse: oneLine(20),
	},
	{
		name: "HOSTINGER_ARC_KUBECONFIG",
		label: "Hostinger ARC cluster kubeconfig (base64, one line)",
		purpose:
			"The ARC cluster's kubeconfig as one base64 line (base64 -w0 kubeconfig). HoBo uses it for hobo ci fleet caches.",
		minLength: 20,
		maxLength: 65536,
		parse: kubeconfig,
	},
	{
		name: "HOBO_CI_ACCOUNT_TOKEN",
		label: "HoBo CI relay account credential",
		purpose:
			"The CI account credential your HoBo CI relay operator issued. hobo ci uses it to reach the relay; GitHub itself goes through HoBo's GitHub App (hobo ci app create).",
		minLength: 20,
		maxLength: 1024,
		parse: oneLine(20),
	},
]);

// public-contract: the title hosts show for store_owner_entries.
export const STORE_OWNER_ENTRIES_TITLE =
	"Ask the owner for HoBo's Hostinger and relay entries";

// public-contract: the description hosts and agents read for store_owner_entries.
export const STORE_OWNER_ENTRIES_DESCRIPTION = `Ask the owner, in private host forms, for the Hostinger entries and HoBo CI relay credential HoBo needs (${OWNER_ENTRY_SPECS.map((s) => s.name).join(", ")}) and write each straight into their connected store. Needs an established store session (choose_secret_store). Returns entry names only.`;

export const STORE_OWNER_ENTRIES_INPUT: JsonObject = {
	type: "object",
	properties: {
		cwd: {
			type: "string",
			description:
				"The project directory; the server's working directory by default.",
		},
		family: {
			type: "string",
			enum: ["ci", "cd"],
			description: "The CI or CD store session; defaults to CD.",
		},
		entries: {
			type: "array",
			items: {
				type: "string",
				enum: OWNER_ENTRY_SPECS.map((s) => s.name),
			},
			description: "Only these entries; all of them by default.",
		},
		replace: {
			type: "boolean",
			description:
				"Ask again for entries the store already holds, replacing them.",
		},
	},
	additionalProperties: false,
};

const argsSchema = z.object({
	family: z.enum(["ci", "cd"]).optional().catch(undefined),
	entries: z
		.array(z.enum(OWNER_ENTRY_SPECS.map((s) => s.name)))
		.optional()
		.catch(undefined),
	replace: z.boolean().optional().catch(undefined),
});

const formAnswer = z.object({
	action: z.enum(["accept", "decline", "cancel"]),
	content: z.object({ value: z.string() }).optional(),
});

export type OwnerEntriesResult = Readonly<{
	text: string;
	structured: JsonObject;
	isError: boolean;
}>;

const ATTEMPTS = 3;

export async function storeOwnerEntries(input: {
	readonly cwd: string;
	readonly args: JsonObject;
	readonly sessions: OwnerStoreSessions | undefined;
	readonly ask:
		| ((params: JsonObject) => Promise<JsonValue | undefined>)
		| undefined;
}): Promise<OwnerEntriesResult> {
	const { ask, sessions, cwd } = input;
	const args = argsSchema.parse(input.args);
	const family = args.family ?? "cd";
	if (ask === undefined)
		return {
			text: "This host shows no MCP forms, so HoBo cannot ask the owner for these entries privately. Nothing was asked or stored.",
			structured: { status: "secure-form-unavailable" },
			isError: true,
		};
	if (sessions === undefined || !sessions.status(cwd, family).established)
		return {
			text: "No owner store session is established for this project. Call choose_secret_store first, then ask again.",
			structured: { status: "sign-in-needed" },
			isError: true,
		};
	const wanted = OWNER_ENTRY_SPECS.filter(
		(spec) => args.entries === undefined || args.entries.includes(spec.name),
	);
	const entries = sessions.entries(cwd, family);
	const stored: string[] = [];
	const kept: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];
	for (const spec of wanted) {
		if (args.replace !== true) {
			const held = await entries.read(spec.name).catch(() => undefined);
			if (held !== undefined) {
				kept.push(spec.name);
				continue;
			}
		}
		let problem: string | undefined;
		let value: string | undefined;
		let answered = true;
		for (
			let attempt = 0;
			attempt < ATTEMPTS && value === undefined;
			attempt++
		) {
			const reply = formAnswer.safeParse(
				await ask({
					mode: "form",
					message:
						problem === undefined
							? `${spec.purpose} It goes straight to your store; the agent never sees it.`
							: `${problem} Try again.`,
					requestedSchema: {
						type: "object",
						properties: {
							value: {
								type: "string",
								title: spec.label,
								minLength: spec.minLength,
								maxLength: spec.maxLength,
							},
						},
						required: ["value"],
					},
				}).catch(() => undefined),
			);
			if (!reply.success || reply.data.action !== "accept") {
				answered = false;
				break;
			}
			value = spec.parse(reply.data.content?.value ?? "");
			if (value === undefined)
				problem = `That does not look like a ${spec.label}.`;
		}
		if (!answered || value === undefined) {
			skipped.push(spec.name);
			continue;
		}
		try {
			await entries.write(spec.name, value);
			stored.push(spec.name);
		} catch {
			failed.push(spec.name);
		}
	}
	const parts = [
		stored.length > 0
			? `Stored in the owner's store: ${stored.join(", ")}.`
			: "",
		kept.length > 0 ? `Already there, kept: ${kept.join(", ")}.` : "",
		skipped.length > 0 ? `Not given by the owner: ${skipped.join(", ")}.` : "",
		failed.length > 0
			? `The store refused the write for: ${failed.join(", ")}.`
			: "",
	].filter((part) => part !== "");
	return {
		text: parts.join(" ") || "Nothing to ask for.",
		structured: {
			status: failed.length > 0 ? "partly-stored" : "stored",
			stored,
			kept,
			skipped,
			failed,
		},
		isError: failed.length > 0,
	};
}
