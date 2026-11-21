import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Agent37Client, createAgent37Client } from "../src/index.js";
import {
	createAgent37FakeServer,
	type FakeAgent37Server,
	generateAgent37TestApiKey,
} from "./fake/index.ts";

describe("Agent37 client contracts", () => {
	let fake: FakeAgent37Server;
	let client: Agent37Client;
	let requests: string[];

	beforeEach(async () => {
		fake = await createAgent37FakeServer({
			apiKey: generateAgent37TestApiKey(),
			execHandler: ({ command }) => ({
				stdout: `${command}\n`,
				stderr: "",
				exitCode: 0,
			}),
		});
		requests = [];
		const fetchImpl: typeof globalThis.fetch = async (input, init) => {
			const source = new Request(input).url;
			const url = new URL(source);
			requests.push(source);
			return fetch(`${fake.baseUrl}${url.pathname}${url.search}`, init);
		};
		client = createAgent37Client({
			apiKey: fake.apiKey,
			fetchImpl,
			sleep: async () => {},
			random: () => 0,
		});
	});

	afterEach(async () => {
		await fake.close();
	});

	it("creates, gets, lists newest first, and deletes instances", async () => {
		const first = await client.createInstance({
			template: "agent37-ubuntu",
			type: "vm",
			region: "us",
			resources: { cpu: 2, memory: 4, disk: 20 },
			name: "hobo-a37-first",
			metadata: { hobo: "ci", leaseId: "lease-first" },
			env: { HOBO_LEASE_ID: "lease-first" },
		});
		expect(first).toMatchObject({
			id: expect.any(String),
			status: "running",
			resources: { cpu: 2, memory: 4, disk: 20 },
			metadata: { hobo: "ci", leaseId: "lease-first" },
		});
		expect(first).not.toHaveProperty("env");

		const second = await client.createInstance({
			template: "agent37-ubuntu",
			type: "vm",
			resources: { cpu: 2, memory: 4, disk: 20 },
			name: "hobo-a37-second",
		});
		expect((await client.getInstance(first.id)).id).toBe(first.id);
		expect((await client.listInstances()).map((item) => item.id)).toEqual([
			second.id,
			first.id,
		]);

		await client.deleteInstance(first.id);
		expect((await client.listInstances()).map((item) => item.id)).toEqual([
			second.id,
		]);
	});

	it("runs synchronous and idempotent background exec on the sandbox plane", async () => {
		const created = await client.createInstance({
			template: "agent37-ubuntu",
			type: "vm",
			resources: { cpu: 2, memory: 4, disk: 20 },
		});
		const sync = await client.exec(created.id, {
			command: "printf ready",
			user: "root",
			name: "prepare-lease",
		});
		expect(sync).toMatchObject({
			exit_code: 0,
			stdout: "printf ready\n",
			status: "completed",
		});
		expect(
			await client.exec(created.id, {
				command: "printf changed",
				name: "prepare-lease",
			}),
		).toEqual(sync);
		expect(fake.state.execInvocations).toHaveLength(1);

		const background = await client.exec(created.id, {
			command: "./run.sh",
			background: true,
			name: "start-lease",
		});
		expect(background).toMatchObject({ background: true, status: "running" });
		expect(requests.at(-1)).toBe(
			`https://sandbox.agent37.app/v1/instances/${created.id}/exec`,
		);
	});

	it("registers, lists, and deletes webhooks without listing secrets", async () => {
		const registered = await client.registerWebhook(
			"https://hooks.example.com/agent37",
		);
		expect(registered.secret.startsWith("whsec_")).toBe(true);
		const listed = await client.listWebhooks();
		expect(listed).toHaveLength(1);
		expect(listed[0]).not.toHaveProperty("secret");
		await client.deleteWebhook(registered.id);
		expect(await client.listWebhooks()).toEqual([]);
	});

	it("reads usage with an optional bounded date window", async () => {
		const result = await client.usage({
			from: "2026-11-01",
			to: "2026-11-20",
		});
		expect(result).toMatchObject({
			from: "2026-11-01",
			to: "2026-11-20",
			total_micros: 0,
			by_integration: { compute: { cost_micros: 0, awake_minutes: 0 } },
		});
		expect(requests.at(-1)).toBe(
			"https://api.agent37.com/v1/usage?from=2026-11-01&to=2026-11-20",
		);
	});

	it("retries a transient fake fault and then parses the success", async () => {
		fake.state.failNextRequest = { status: 503, code: "no_capacity" };
		expect(await client.listInstances()).toEqual([]);
		expect(requests).toHaveLength(2);
	});
});
