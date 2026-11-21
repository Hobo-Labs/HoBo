import {
	createAgent37FakeServer,
	type FakeAgent37Server,
	generateAgent37TestApiKey,
} from "@hobo/provider-agent37/fake";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Agent37Client, createAgent37Client } from "../src/index.js";

const createInput = {
	template: "agent37-ubuntu",
	type: "vm" as const,
	region: "us" as const,
	resources: { cpu: 2, memory: 4, disk: 20 },
};

describe("Agent37 client and published fake contracts", () => {
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
			...createInput,
			name: "hobo-a37-first",
			metadata: { hobo: "ci", leaseId: "lease-first" },
			env: { HOBO_LEASE_ID: "lease-first" },
		});
		expect(first).toMatchObject({
			status: "running",
			resources: { cpu: 2, memory: 4, disk: 20 },
			metadata: { hobo: "ci", leaseId: "lease-first" },
		});
		expect(first).not.toHaveProperty("env");
		const second = await client.createInstance({
			...createInput,
			name: "hobo-a37-second",
		});
		expect((await client.getInstance(first.id)).id).toBe(first.id);
		expect((await client.listInstances()).map((item) => item.id)).toEqual([
			second.id,
			first.id,
		]);
		expect(fake.state.instances).toHaveLength(2);
		await client.deleteInstance(first.id);
		expect((await client.listInstances()).map((item) => item.id)).toEqual([
			second.id,
		]);
	});

	it("runs synchronous, background, and named idempotent exec", async () => {
		const created = await client.createInstance(createInput);
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

	it("reads usage with a bounded date window", async () => {
		const result = await client.usage({ from: "2026-11-01", to: "2026-11-20" });
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

	it("rejects unknown create controls before transport", () => {
		for (const input of [
			{ ...createInput, networkk: "allow-all" },
			{ ...createInput, resources: { cpu: 2, memory: 4, disk: 20, diskk: 30 } },
			{ ...createInput, network: { allow: ["10.0.0.0/8"], allow_all: true } },
		]) {
			expect(() =>
				client.createInstance(JSON.parse(JSON.stringify(input))),
			).toThrow("request input");
		}
		expect(requests).toEqual([]);
	});

	it("rejects unknown exec and usage keys before transport", () => {
		expect(() =>
			client.exec(
				"i_test",
				JSON.parse('{"command":"true","backgroundd":true}'),
			),
		).toThrow("request input");
		expect(() =>
			client.usage(JSON.parse('{"from":"2026-11-01","too":"2026-11-20"}')),
		).toThrow("request input");
		expect(requests).toEqual([]);
	});

	it("accepts only HTTPS or loopback HTTP webhook URLs", async () => {
		for (const url of [
			"http://hooks.example.com/agent37",
			"http://127.0.0.1.evil.example/agent37",
			"ftp://localhost/agent37",
		]) {
			expect(() => client.registerWebhook(url)).toThrow("request input");
		}
		expect(requests).toEqual([]);
		const registered = await client.registerWebhook(
			"http://127.0.0.1:4180/agent37",
		);
		expect(registered.url).toBe("http://127.0.0.1:4180/agent37");
	});

	it("retries a transient read fault and parses the success", async () => {
		fake.state.failNextRequest = { status: 503, code: "no_capacity" };
		expect(await client.listInstances()).toEqual([]);
		expect(requests).toHaveLength(2);
	});
});

describe("Agent37 error retryability", () => {
	const failingClient = () =>
		createAgent37Client({
			apiKey: generateAgent37TestApiKey(),
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						error: { code: "internal_error", message: "fixture" },
					}),
					{ status: 503, headers: { "content-type": "application/json" } },
				),
			maxAttempts: 1,
		});

	it("does not mark create responses retryable", async () => {
		await expect(
			failingClient().createInstance(createInput),
		).rejects.toMatchObject({
			status: 503,
			retryable: false,
		});
	});

	it("marks only named exec responses retryable for caller-controlled replay", async () => {
		await expect(
			failingClient().exec("i_test", { command: "printf ready" }),
		).rejects.toMatchObject({ status: 503, retryable: false });
		await expect(
			failingClient().exec("i_test", {
				command: "printf ready",
				name: "prepare-lease",
			}),
		).rejects.toMatchObject({ status: 503, retryable: true });
	});

	it("marks exhausted GET responses retryable", async () => {
		await expect(failingClient().listInstances()).rejects.toMatchObject({
			status: 503,
			retryable: true,
		});
	});
});

describe("Agent37 response parsing", () => {
	const clientFor = (status: number, body: string) =>
		createAgent37Client({
			apiKey: generateAgent37TestApiKey(),
			fetchImpl: async () =>
				new Response(body === "" ? null : body, { status }),
			maxAttempts: 1,
		});

	it.each(["deleteInstance", "deleteWebhook"] as const)(
		"%s requires deleted:true on 200 and empty 204",
		async (method) => {
			for (const body of [
				"",
				JSON.stringify({ id: "resource", deleted: false }),
			]) {
				await expect(clientFor(200, body)[method]("resource")).rejects.toThrow(
					"response did not match",
				);
			}
			for (const [status, body] of [
				[200, JSON.stringify({ id: "resource", deleted: true })],
				[204, ""],
			] as const) {
				await expect(
					clientFor(status, body)[method]("resource"),
				).resolves.toBeUndefined();
			}
		},
	);

	it("rejects malformed JSON success bodies", async () => {
		await expect(clientFor(200, "{").listInstances()).rejects.toThrow(
			"malformed JSON",
		);
	});

	it("rejects structurally invalid success bodies", async () => {
		await expect(
			clientFor(
				200,
				JSON.stringify({ instances: [{ id: "missing-fields" }] }),
			).listInstances(),
		).rejects.toThrow("response did not match");
	});
});
