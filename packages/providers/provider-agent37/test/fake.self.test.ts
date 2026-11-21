import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createAgent37FakeServer,
	type FakeAgent37Server,
	generateAgent37TestApiKey,
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "@hobo/provider-agent37/fake";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type FakeResponse = {
	readonly status: number;
	readonly headers: Headers;
	readonly body: JsonValue;
};

const createBody = {
	template: "agent37-ubuntu",
	type: "vm",
	region: "us",
	resources: { cpu: 2, memory: 4, disk: 20 },
	name: "hobo-a37-test",
	metadata: { hobo: "ci", leaseId: "lease-test" },
	env: { HOBO_LEASE_ID: "lease-test" },
};

function field(value: JsonValue, name: string): JsonValue | undefined {
	if (!isJsonObject(value)) throw new Error(`expected object field ${name}`);
	return value[name];
}

function stringField(value: JsonValue, name: string): string {
	const result = field(value, name);
	if (!isJsonString(result)) throw new Error(`expected string field ${name}`);
	return result;
}

function arrayField(value: JsonValue, name: string): JsonValue[] {
	const result = field(value, name);
	if (!isJsonArray(result)) throw new Error(`expected array field ${name}`);
	return result;
}

async function responseOf(response: Response): Promise<FakeResponse> {
	if (response.status === 204) {
		return { status: response.status, headers: response.headers, body: null };
	}
	const body: JsonValue = await response.json();
	return { status: response.status, headers: response.headers, body };
}

async function api(
	fake: FakeAgent37Server,
	method: string,
	path: string,
	body?: JsonValue,
	apiKey = fake.apiKey,
): Promise<FakeResponse> {
	const headers = new Headers({ authorization: `Bearer ${apiKey}` });
	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		headers.set("content-type", "application/json");
		init.body = JSON.stringify(body);
	}
	const response = await fetch(`${fake.baseUrl}${path}`, init);
	return responseOf(response);
}

async function exec(
	fake: FakeAgent37Server,
	instanceId: string,
	body: JsonValue,
	apiKey = fake.apiKey,
): Promise<FakeResponse> {
	const response = await fetch(
		`${fake.baseUrl}/v1/instances/${instanceId}/exec`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "x-agent37-key": apiKey },
			body: JSON.stringify(body),
		},
	);
	return responseOf(response);
}

async function createInstance(
	fake: FakeAgent37Server,
	overrides: JsonObject = {},
): Promise<FakeResponse> {
	return api(fake, "POST", "/v1/instances", { ...createBody, ...overrides });
}

function requiredHeader(value: string | string[] | undefined): string {
	if (Array.isArray(value)) return value[0] ?? "";
	if (value === undefined) throw new Error("missing webhook header");
	return value;
}

function isTcpAddress(
	value: string | AddressInfo | null,
): value is AddressInfo {
	return (
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

describe("Agent37 offline fake", () => {
	let fake: FakeAgent37Server;

	beforeEach(async () => {
		fake = await createAgent37FakeServer({
			apiKey: generateAgent37TestApiKey(),
		});
	});

	afterEach(async () => {
		await fake.close();
	});

	it("supports CRUD without exposing write-only env", async () => {
		const first = await createInstance(fake);
		expect(first.status).toBe(201);
		expect(first.body).toMatchObject({
			name: "hobo-a37-test",
			resources: { cpu: 2, memory: 4, disk: 20 },
			status: "running",
		});
		expect(first.body).not.toHaveProperty("env");
		const firstId = stringField(first.body, "id");
		const second = await createInstance(fake, { name: "hobo-a37-second" });
		const secondId = stringField(second.body, "id");
		const list = await api(fake, "GET", "/v1/instances");
		expect(
			arrayField(list.body, "instances").map((item) => stringField(item, "id")),
		).toEqual([secondId, firstId]);
		expect(
			stringField(
				(await api(fake, "GET", `/v1/instances/${firstId}`)).body,
				"id",
			),
		).toBe(firstId);
		expect((await api(fake, "DELETE", `/v1/instances/${firstId}`)).status).toBe(
			204,
		);
		expect((await api(fake, "GET", `/v1/instances/${firstId}`)).status).toBe(
			404,
		);
	});

	it("rejects wrong and missing credentials on both planes", async () => {
		const wrongKey = generateAgent37TestApiKey();
		expect(
			(await api(fake, "GET", "/v1/instances", undefined, wrongKey)).status,
		).toBe(401);
		const id = stringField((await createInstance(fake)).body, "id");
		expect((await exec(fake, id, { command: "true" }, wrongKey)).status).toBe(
			401,
		);
		const missing = await fetch(`${fake.baseUrl}/v1/instances/${id}/exec`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: "true" }),
		});
		expect(missing.status).toBe(401);
		expect(fake.state.execInvocations).toHaveLength(0);
	});

	it("enforces balance, memory, and regional capacity errors", async () => {
		fake.state.walletUsd = 0;
		expect((await createInstance(fake)).status).toBe(402);
		expect(fake.state.instances).toHaveLength(0);
		fake.state.walletUsd = 5;
		fake.state.memoryLimitGb = 4;
		const first = await createInstance(fake);
		const firstId = stringField(first.body, "id");
		const limited = await createInstance(fake);
		expect(limited.status).toBe(409);
		expect(limited.body).toMatchObject({
			error: { code: "instance_limit_reached" },
		});
		expect(
			(await api(fake, "POST", `/v1/instances/${firstId}/stop`, {})).status,
		).toBe(200);
		expect((await createInstance(fake)).status).toBe(201);
		fake.state.regionsWithoutCapacity.add("us");
		const noCapacity = await createInstance(fake);
		expect(noCapacity.status).toBe(503);
		expect(noCapacity.body).toMatchObject({ error: { code: "no_capacity" } });
	});

	it("rejects default VMs outside us and undocumented sizes", async () => {
		expect(
			(await createInstance(fake, { type: "default", region: "eu" })).status,
		).toBe(400);
		expect(
			(
				await createInstance(fake, {
					resources: { cpu: 3, memory: 7, disk: 20 },
				})
			).status,
		).toBe(400);
		expect(
			(
				await createInstance(fake, {
					type: "default",
					resources: { cpu: 8, memory: 64, disk: 20 },
				})
			).status,
		).toBe(400);
	});

	it("exposes injected 429 errors with Retry-After", async () => {
		fake.state.failNextRequest = {
			status: 429,
			code: "rate_limited",
			retryAfterSeconds: 3,
		};
		const response = await api(fake, "GET", "/v1/instances");
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("3");
	});

	it("replays named exec for five minutes and supports background exec", async () => {
		let now = new Date("2026-11-20T00:00:00.000Z");
		await fake.close();
		fake = await createAgent37FakeServer({
			apiKey: generateAgent37TestApiKey(),
			now: () => now,
			execHandler: ({ command }) => ({
				stdout: `${command}\n`,
				stderr: "",
				exitCode: 0,
			}),
		});
		const id = stringField((await createInstance(fake)).body, "id");
		const sync = await exec(fake, id, {
			command: "printf ready",
			name: "prepare",
		});
		expect(sync.body).toMatchObject({
			status: "completed",
			stdout: "printf ready\n",
		});
		expect(
			(await exec(fake, id, { command: "printf changed", name: "prepare" }))
				.body,
		).toEqual(sync.body);
		expect(fake.state.execInvocations).toHaveLength(1);
		const background = await exec(fake, id, {
			command: "./run.sh",
			background: true,
			name: "start",
		});
		expect(background.body).toMatchObject({
			status: "running",
			exit_code: null,
			finished_at: null,
		});
		now = new Date(now.getTime() + 300001);
		const expired = await exec(fake, id, {
			command: "printf ready",
			name: "prepare",
		});
		expect(stringField(expired.body, "id")).not.toBe(
			stringField(sync.body, "id"),
		);
		expect(fake.state.execInvocations).toHaveLength(3);
	});

	it("bounds exec streams at 512 KiB", async () => {
		await fake.close();
		fake = await createAgent37FakeServer({
			apiKey: generateAgent37TestApiKey(),
			execHandler: () => ({
				stdout: "x".repeat(512 * 1024 + 20),
				stderr: "",
				exitCode: 0,
			}),
		});
		const id = stringField((await createInstance(fake)).body, "id");
		const result = await exec(fake, id, { command: "large" });
		expect(stringField(result.body, "stdout")).toHaveLength(512 * 1024);
	});

	it("supports lifecycle, resize, and fork", async () => {
		const id = stringField((await createInstance(fake)).body, "id");
		for (const [verb, status] of [
			["stop", "stopped"],
			["start", "running"],
			["sleep", "sleeping"],
			["start", "running"],
			["restart", "running"],
		] as const) {
			const result = await api(fake, "POST", `/v1/instances/${id}/${verb}`, {});
			expect(stringField(result.body, "status")).toBe(status);
		}
		const update = await api(fake, "POST", `/v1/instances/${id}/update`, {
			template: "agent37-base",
		});
		expect(stringField(update.body, "template")).toBe("agent37-base");
		const resized = await api(fake, "POST", `/v1/instances/${id}/resize`, {
			resources: { cpu: 4, memory: 8, disk: 30 },
		});
		expect(resized.body).toMatchObject({
			resources: { cpu: 4, memory: 8, disk: 30 },
		});
		const forked = await api(fake, "POST", `/v1/instances/${id}/fork`, {
			name: "forked",
		});
		expect(forked.status).toBe(201);
		expect(stringField(forked.body, "name")).toBe("forked");
	});

	it("rejects malformed JSON and oversized request bodies", async () => {
		const id = stringField((await createInstance(fake)).body, "id");
		for (const verb of ["fork", "stop"]) {
			const response = await fetch(
				`${fake.baseUrl}/v1/instances/${id}/${verb}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${fake.apiKey}`,
						"content-type": "application/json",
					},
					body: "{",
				},
			);
			expect(response.status).toBe(400);
		}
		const oversized = await fetch(`${fake.baseUrl}/v1/instances/${id}/exec`, {
			method: "POST",
			headers: {
				"x-agent37-key": fake.apiKey,
				"content-type": "application/json",
			},
			body: JSON.stringify({ command: "x".repeat(1024 * 1024 + 100) }),
		});
		expect(oversized.status).toBe(413);
	});

	it("does not expose unexpected exec handler failures", async () => {
		await fake.close();
		fake = await createAgent37FakeServer({
			apiKey: generateAgent37TestApiKey(),
			execHandler: () => {
				throw new Error("private handler failure");
			},
		});
		const id = stringField((await createInstance(fake)).body, "id");
		const result = await exec(fake, id, { command: "true" });
		expect(result.status).toBe(500);
		expect(result.body).toEqual({
			error: { code: "internal_error", message: "internal server error" },
		});
	});

	it("provides webhook CRUD, limits, and Standard Webhooks signatures", async () => {
		const received: {
			id: string;
			timestamp: string;
			signature: string;
			body: string;
		}[] = [];
		const receiver = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				body += chunk;
			});
			request.on("end", () => {
				received.push({
					id: requiredHeader(request.headers["webhook-id"]),
					timestamp: requiredHeader(request.headers["webhook-timestamp"]),
					signature: requiredHeader(request.headers["webhook-signature"]),
					body,
				});
				response.writeHead(204).end();
			});
		});
		await new Promise<void>((resolve, reject) => {
			receiver.once("error", reject);
			receiver.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = receiver.address();
			if (!isTcpAddress(address)) throw new Error("missing TCP address");
			const registration = await api(fake, "POST", "/v1/webhooks", {
				url: `http://127.0.0.1:${address.port}/agent37`,
			});
			expect(registration.status).toBe(201);
			const webhookId = stringField(registration.body, "id");
			const secret = stringField(registration.body, "secret");
			const id = stringField((await createInstance(fake)).body, "id");
			expect(received).toHaveLength(1);
			const delivery = received[0];
			if (delivery === undefined) throw new Error("missing webhook delivery");
			const expected = `v1,${createHmac(
				"sha256",
				Buffer.from(secret.slice(6), "base64"),
			)
				.update(`${delivery.id}.${delivery.timestamp}.${delivery.body}`)
				.digest("base64")}`;
			expect(delivery.signature).toBe(expected);
			expect(JSON.parse(delivery.body)).toMatchObject({
				type: "instance.status_changed",
				data: { instance: { id, status: "running" } },
			});
			const list = await api(fake, "GET", "/v1/webhooks");
			expect(arrayField(list.body, "webhooks")).toHaveLength(1);
			expect(list.body).not.toHaveProperty("webhooks.0.secret");
			for (let index = 0; index < 4; index += 1) {
				expect(
					(
						await api(fake, "POST", "/v1/webhooks", {
							url: `https://hooks.example.com/${index}`,
						})
					).status,
				).toBe(201);
			}
			expect(
				(
					await api(fake, "POST", "/v1/webhooks", {
						url: "https://hooks.example.com/sixth",
					})
				).status,
			).toBe(409);
			expect(
				(await api(fake, "DELETE", `/v1/webhooks/${webhookId}`)).status,
			).toBe(204);
		} finally {
			receiver.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				receiver.close((error) =>
					error === undefined ? resolve() : reject(error),
				);
			});
		}
	});

	it("rejects non-HTTPS webhook targets except loopback HTTP", async () => {
		for (const url of [
			"http://hooks.example.com/agent37",
			"ftp://localhost/agent37",
		]) {
			expect((await api(fake, "POST", "/v1/webhooks", { url })).status).toBe(
				400,
			);
		}
		expect(
			(
				await api(fake, "POST", "/v1/webhooks", {
					url: "http://[::1]:4180/agent37",
				})
			).status,
		).toBe(201);
	});

	it("returns usage for the requested dates", async () => {
		await createInstance(fake);
		const result = await api(
			fake,
			"GET",
			"/v1/usage?from=2026-11-01&to=2026-11-20",
		);
		expect(result.body).toMatchObject({
			from: "2026-11-01",
			to: "2026-11-20",
			total_micros: 0,
		});
		expect(arrayField(result.body, "instances")).toHaveLength(1);
	});
});
