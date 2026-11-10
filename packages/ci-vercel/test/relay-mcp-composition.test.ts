import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { create, type JsonObject, toJsonString } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	OfferSchema,
} from "@hobo/ci";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createVercelApplication } from "../src/composition.js";

/** Real PostgreSQL: a server whose role may create databases. */
const server = process.env.HOBO_TEST_POSTGRES_URL;
const database = `hobo_mcp_${randomBytes(6).toString("hex")}`;
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

function configuration(): string {
	return toJsonString(
		ConfigurationSchema,
		create(ConfigurationSchema, {
			accounts: [
				create(AccountSchema, {
					id: "account-a",
					budgetMicros: 1000000,
					maxRuntimeMinutes: 9,
					startupMinutes: 1,
					offers: [
						create(OfferSchema, {
							id: "blacksmith-a",
							provider: "blacksmith",
							providerAccountId: "owned-blacksmith-account",
							enabled: true,
							runsOn: "blacksmith-2vcpu-ubuntu-2404",
							freeMinutes: 10,
							priceMicrosPerMinute: 4000,
							budgetMicros: 1000000,
							concurrency: 1,
							observedAt: "2026-10-26T00:00:00Z",
							validUntil: "2026-10-27T00:00:00Z",
							sourceUrl: "https://example.test/usage",
							bridgeAcknowledged: true,
						}),
					],
				}),
			],
			connections: [
				create(ConnectionSchema, {
					accountId: "account-a",
					repository: "org/repo",
					repositoryId: 101,
					installationId: 10,
					bridgeWorkflow: "host.yml",
					bridgeSha: "a".repeat(40),
					runnerGroupId: 1,
					allowedEvents: ["push"],
					allowedRefs: ["refs/heads/main"],
					trustedRepositoryAcknowledged: true,
					bridgeRef: "hobo-ci-v1",
					dispatcherActorId: 123,
				}),
			],
		}),
	);
}

describe.runIf(!!server)("Vercel composition", () => {
	it("serves MCP at /mcp without sessions, with JSON, inside the function's time", async () => {
		if (!server) throw new Error("postgres server unavailable");
		const admin = new pg.Pool({ connectionString: server, max: 1 });
		cleanup.push(() => admin.end());
		await admin.query(`CREATE DATABASE ${database}`);
		cleanup.push(async () => {
			await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
		});
		const url = new URL(server);
		url.pathname = `/${database}`;
		const token = randomBytes(24).toString("base64url");
		const settings = { connectionString: url.toString() };
		const app = await createVercelApplication({
			env: {
				HOBO_CI_PUBLIC_URL: "https://ci.example.test",
				HOBO_CI_GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", {
					modulusLength: 2048,
				})
					.privateKey.export({ type: "pkcs8", format: "pem" })
					.toString(),
				HOBO_CI_GITHUB_APP_ID: "12345",
				HOBO_CI_WEBHOOK_SECRET: randomBytes(24).toString("base64url"),
				CRON_SECRET: randomBytes(24).toString("base64url"),
				HOBO_CI_CONTROL_TOKENS_JSON: JSON.stringify({
					tokens: [
						{
							accountId: "account-a",
							installationIds: [10],
							tokenSha256: createHash("sha256").update(token).digest("hex"),
							scopes: ["policy:read"],
						},
					],
				}),
				HOBO_CI_CONFIG_JSON: configuration(),
			},
			notify: async () => undefined,
			continueRepair: async () => undefined,
			scheduledRepair: async () => undefined,
			database: { primary: settings, direct: settings },
		});
		cleanup.push(() => app.close());
		const rpc = (body: JsonObject, authorization = `Bearer ${token}`) =>
			app.handle(
				new Request("https://ci.example.test/mcp", {
					method: "POST",
					headers: {
						authorization,
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			);

		const anonymous = await rpc(
			{ jsonrpc: "2.0", id: 1, method: "ping" },
			"Bearer nobody",
		);
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");

		const initialized = await rpc({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "composition", version: "1.0.0" },
			},
		});
		expect(initialized.status).toBe(200);
		// A function instance does not outlive the request: JSON, no session,
		// and no promise to push resource updates.
		expect(initialized.headers.get("content-type")).toBe("application/json");
		expect(initialized.headers.get("mcp-session-id")).toBe(null);
		const hello = z
			.object({
				result: z.object({
					serverInfo: z.object({ name: z.string() }),
					capabilities: z.object({
						resources: z.object({ subscribe: z.boolean().optional() }),
					}),
				}),
			})
			.parse(await initialized.json());
		expect(hello.result.serverInfo.name).toBe("hobo-ci-relay");
		expect(hello.result.capabilities.resources.subscribe).toBe(undefined);

		const status = z
			.object({
				result: z.object({
					structuredContent: z.object({
						subscriptions: z.boolean(),
						waitMaxSeconds: z.number(),
						engines: z.array(z.object({ id: z.string() })),
					}),
				}),
			})
			.parse(
				await (
					await rpc({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: "get_relay_status", arguments: {} },
					})
				).json(),
			);
		expect(status.result.structuredContent).toMatchObject({
			subscriptions: false,
			// The ceiling the function's declared duration allows.
			waitMaxSeconds: 50,
			engines: [{ id: "gh-actions" }],
		});

		// The store behind it is the real one: the account's journal is read.
		const events = z
			.object({
				result: z.object({
					structuredContent: z.object({
						events: z.array(z.object({ type: z.string() })),
						cursor: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
					}),
				}),
			})
			.parse(
				await (
					await rpc({
						jsonrpc: "2.0",
						id: 3,
						method: "tools/call",
						params: { name: "list_events", arguments: {} },
					})
				).json(),
			);
		expect(events.result.structuredContent.events).toEqual([]);

		const listen = await app.handle(
			new Request("https://ci.example.test/mcp", {
				headers: {
					authorization: `Bearer ${token}`,
					accept: "text/event-stream",
				},
			}),
		);
		expect(listen.status).toBe(405);
		expect(listen.headers.get("allow")).toBe("POST");
	}, 60_000);
});
