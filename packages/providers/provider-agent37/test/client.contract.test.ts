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

	it("rejects unknown create-instance controls instead of dropping them", () => {
		const valid = {
			template: "agent37-ubuntu",
			type: "vm",
			resources: { cpu: 2, memory: 4, disk: 20 },
			auto_sleep: true,
			network: "deny-all",
		};
		for (const input of [
			{ ...valid, networkk: "allow-all" },
			{ ...valid, resources: { cpu: 2, memory: 4, disk: 20, diskk: 30 } },
			{ ...valid, network: { allow: ["10.0.0.0/8"], allow_all: true } },
		]) {
			expect(() =>
				client.createInstance(JSON.parse(JSON.stringify(input))),
			).toThrow();
		}
		expect(requests).toEqual([]);
	});

	it("rejects plaintext webhook URLs before transport", () => {
		expect(() =>
			client.registerWebhook("http://hooks.example.com/agent37"),
		).toThrow("Agent37 webhooks require HTTPS");
		expect(requests).toEqual([]);
	});

	it("retries a transient fake fault and then parses the success", async () => {
		fake.state.failNextRequest = { status: 503, code: "no_capacity" };
		expect(await client.listInstances()).toEqual([]);
		expect(requests).toHaveLength(2);
	});
});

describe("Agent37 error retryability", () => {
	const clientForServerError = () =>
		createAgent37Client({
			apiKey: "sk_live_retryability_contract",
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						error: { code: "internal_error", message: "test" },
					}),
					{ status: 503, headers: { "content-type": "application/json" } },
				),
			maxAttempts: 1,
		});

	it("does not mark create-instance 5xx responses retryable, even when named", async () => {
		const input = {
			template: "agent37-ubuntu",
			type: "vm",
			resources: { cpu: 2, memory: 4, disk: 20 },
		} as const;
		for (const createInput of [input, { ...input, name: "ci-runner" }]) {
			await expect(
				clientForServerError().createInstance(createInput),
			).rejects.toMatchObject({ status: 503, retryable: false });
		}
	});

	it("marks only named exec 5xx responses retryable", async () => {
		await expect(
			clientForServerError().exec("i_test", { command: "printf ready" }),
		).rejects.toMatchObject({ status: 503, retryable: false });
		await expect(
			clientForServerError().exec("i_test", {
				command: "printf ready",
				name: "prepare-lease",
			}),
		).rejects.toMatchObject({ status: 503, retryable: true });
	});

	it("keeps GET 5xx responses retryable", async () => {
		await expect(clientForServerError().listInstances()).rejects.toMatchObject({
			status: 503,
			retryable: true,
		});
	});
});

describe("Agent37 deletion response contracts", () => {
	const clientFor = (status: number, body: string) =>
		createAgent37Client({
			apiKey: "sk_live_deletion_contract",
			fetchImpl: async () =>
				new Response(body === "" ? null : body, { status }),
		});

	it.each([
		"deleteInstance",
		"deleteWebhook",
	] as const)("%s requires deleted:true on 200", async (method) => {
		for (const body of [
			"",
			JSON.stringify({ id: "resource", deleted: false }),
		]) {
			const client = clientFor(200, body);
			await expect(client[method]("resource")).rejects.toThrow(
				"Agent37 response did not match its contract",
			);
		}
	});

	it.each([
		"deleteInstance",
		"deleteWebhook",
	] as const)("%s accepts deleted:true on 200 and an empty 204", async (method) => {
		for (const [status, body] of [
			[200, JSON.stringify({ id: "resource", deleted: true })],
			[204, ""],
		] as const) {
			const client = clientFor(status, body);
			await expect(client[method]("resource")).resolves.toBeUndefined();
		}
	});
});
