import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../src/json.js";
import { storeOwnerEntries } from "../src/mcp-owner-entries.js";
import {
	createStoreChoiceApp,
	STORE_CHOICE_TOOL_NAMES,
} from "../src/mcp-store-choice.js";
import type { OwnerStoreSessions } from "../src/owner-store-session.js";

const HOSTINGER = "hostinger-fixture-token-0123456789";
const GITHUB = "github_pat_fixture0123456789";
const KUBECONFIG = "apiVersion: v1\nkind: Config\nclusters: []\n";

function fakeSessions(
	held: Map<string, string>,
	established = true,
): OwnerStoreSessions {
	return {
		establish: async () => ({ status: "established", store: "Infisical" }),
		status: () =>
			established
				? { established: true, store: "Infisical" }
				: { established: false },
		credentials: () => ({
			resolve: async () => {
				throw new Error("unused");
			},
		}),
		entries: () => ({
			read: async (name) => held.get(name),
			write: async (name, value) => {
				held.set(name, value);
			},
		}),
		close: () => undefined,
	};
}

function answers(values: readonly (string | undefined)[]) {
	const asked: JsonObject[] = [];
	let next = 0;
	const ask = async (params: JsonObject): Promise<JsonValue | undefined> => {
		asked.push(params);
		const value = values[next++];
		return value === undefined
			? { action: "decline" }
			: { action: "accept", content: { value } };
	};
	return { ask, asked };
}

describe("store_owner_entries", () => {
	it("asks for each missing entry in a host form and writes it to the owner's store", async () => {
		const held = new Map<string, string>([["GITHUB_RELEASE_TOKEN", "kept"]]);
		const { ask, asked } = answers([
			HOSTINGER,
			Buffer.from(KUBECONFIG).toString("base64"),
			GITHUB,
		]);
		const outcome = await storeOwnerEntries({
			cwd: "/p",
			args: {},
			sessions: fakeSessions(held),
			ask,
		});
		expect(outcome.structured).toEqual({
			status: "stored",
			stored: [
				"HOSTINGER_API_TOKEN",
				"HOSTINGER_ARC_KUBECONFIG",
				"HOBO_CI_ACCOUNT_TOKEN",
			],
			kept: ["GITHUB_RELEASE_TOKEN"],
			skipped: [],
			failed: [],
		});
		expect(held.get("HOSTINGER_API_TOKEN")).toBe(HOSTINGER);
		expect(held.get("HOSTINGER_ARC_KUBECONFIG")).toBe(KUBECONFIG);
		expect(held.get("HOBO_CI_ACCOUNT_TOKEN")).toBe(GITHUB);
		expect(asked.every((p) => p.mode === "form")).toBe(true);
		expect(JSON.stringify(outcome)).not.toContain(HOSTINGER);
		expect(JSON.stringify(outcome)).not.toContain(GITHUB);
	});

	it("asks again with the reason when a value is malformed, and records a decline", async () => {
		const held = new Map<string, string>();
		const { ask, asked } = answers(["has spaces in it", HOSTINGER, undefined]);
		const outcome = await storeOwnerEntries({
			cwd: "/p",
			args: { entries: ["HOSTINGER_API_TOKEN", "HOBO_CI_ACCOUNT_TOKEN"] },
			sessions: fakeSessions(held),
			ask,
		});
		expect(asked).toHaveLength(3);
		expect(String(asked[1]?.message)).toContain("does not look like");
		expect(outcome.structured).toMatchObject({
			stored: ["HOSTINGER_API_TOKEN"],
			skipped: ["HOBO_CI_ACCOUNT_TOKEN"],
		});
	});

	it("refuses without a store session or without host forms", async () => {
		const held = new Map<string, string>();
		const { ask } = answers([]);
		expect(
			(
				await storeOwnerEntries({
					cwd: "/p",
					args: {},
					sessions: fakeSessions(held, false),
					ask,
				})
			).structured,
		).toEqual({ status: "sign-in-needed" });
		expect(
			(
				await storeOwnerEntries({
					cwd: "/p",
					args: {},
					sessions: fakeSessions(held),
					ask: undefined,
				})
			).structured,
		).toEqual({ status: "secure-form-unavailable" });
	});

	it("is listed and routed by the store choice app when a session store exists", async () => {
		expect(STORE_CHOICE_TOOL_NAMES).toContain("store_owner_entries");
		const held = new Map<string, string>();
		const app = createStoreChoiceApp({
			cwd: "/p",
			locatorFor: () => ({ read: async () => ({}), write: async () => {} }),
			sessions: fakeSessions(held),
		});
		const support = { formElicitation: true, apps: false };
		expect(app.tools(support).map((t) => t.name)).toContain(
			"store_owner_entries",
		);
		const result = await app.callTool(
			"store_owner_entries",
			{ entries: ["HOSTINGER_API_TOKEN"] },
			support,
			async () => ({ action: "accept", content: { value: HOSTINGER } }),
		);
		expect(result.structuredContent).toMatchObject({
			stored: ["HOSTINGER_API_TOKEN"],
		});
		expect(held.get("HOSTINGER_API_TOKEN")).toBe(HOSTINGER);
	});
});
