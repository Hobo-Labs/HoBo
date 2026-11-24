import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { JsonObject, JsonValue } from "../src/json.js";
import { storeOwnerEntries } from "../src/mcp-owner-entries.js";
import {
	createStoreChoiceApp,
	STORE_CHOICE_TOOL_NAMES,
} from "../src/mcp-store-choice.js";
import type { OwnerStoreSessions } from "../src/owner-store-session.js";

const HOSTINGER = "hostinger-fixture-token-0123456789";
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
		const held = new Map<string, string>([["HOBO_CI_ACCOUNT_TOKEN", "kept"]]);
		const { ask, asked } = answers([
			HOSTINGER,
			Buffer.from(KUBECONFIG).toString("base64"),
		]);
		const outcome = await storeOwnerEntries({
			cwd: "/p",
			args: {},
			sessions: fakeSessions(held),
			ask,
		});
		expect(outcome.structured).toEqual({
			status: "stored",
			stored: ["HOSTINGER_API_TOKEN", "HOSTINGER_ARC_KUBECONFIG"],
			kept: ["HOBO_CI_ACCOUNT_TOKEN"],
			skipped: [],
			failed: [],
		});
		expect(held.get("HOSTINGER_API_TOKEN")).toBe(HOSTINGER);
		expect(held.get("HOSTINGER_ARC_KUBECONFIG")).toBe(KUBECONFIG);
		expect(held.get("HOBO_CI_ACCOUNT_TOKEN")).toBe("kept");
		expect(asked.every((p) => p.mode === "form")).toBe(true);
		expect(JSON.stringify(outcome)).not.toContain(HOSTINGER);
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

const here = path.dirname(fileURLToPath(import.meta.url));

describe("a reconnecting host", () => {
	it("is told the tool list changed, and lists store_owner_entries", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "hobo-mcp-list-changed-"));
		const child = spawn(
			process.execPath,
			["--import", "tsx", path.join(here, "../src/bin/hobo-mcp.ts")],
			{
				cwd: path.join(here, ".."),
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					XDG_CONFIG_HOME: home,
				},
				stdio: ["pipe", "pipe", "ignore"],
			},
		);
		const lines: string[] = [];
		let buffered = "";
		const listed = new Promise<void>((resolve) => {
			child.stdout.on("data", (chunk: Buffer) => {
				buffered += chunk.toString();
				const parts = buffered.split("\n");
				buffered = parts.pop() ?? "";
				lines.push(...parts.filter((line) => line !== ""));
				if (lines.some((line) => line.includes('"id":2'))) resolve();
			});
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "t", version: "1" } } })}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
		);
		await listed;
		child.kill();
		const messages = lines.map((line) =>
			z
				.object({
					id: z.number().optional(),
					method: z.string().optional(),
					result: z
						.object({
							capabilities: z
								.object({ tools: z.object({ listChanged: z.boolean() }) })
								.optional(),
							tools: z.array(z.object({ name: z.string() })).optional(),
						})
						.optional(),
				})
				.parse(JSON.parse(line)),
		);
		expect(
			messages.find((m) => m.id === 1)?.result?.capabilities?.tools.listChanged,
		).toBe(true);
		expect(
			messages.some((m) => m.method === "notifications/tools/list_changed"),
		).toBe(true);
		expect(
			messages.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name),
		).toContain("store_owner_entries");
	}, 60_000);
});
