import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent37FakeServer, type FakeAgent37Server } from "./index.ts";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./server.mts";

type FakeResponse = {
	readonly status: number;
	readonly headers: Headers;
	readonly body: JsonValue;
};

type ReceivedWebhook = {
	readonly id: string;
	readonly timestamp: string;
	readonly signature: string;
	readonly body: string;
};

const createRequest = {
	template: "agent37-ubuntu",
	type: "vm",
	region: "us",
	resources: { cpu: 2, memory: 4, disk: 20 },
	name: "hobo-a37-test",
	metadata: { hobo: "ci", leaseId: "lease-test" },
	env: { HOBO_LEASE_ID: "lease-test" },
};

function generatedKey(): string {
	return `sk_live_${randomBytes(24).toString("base64url")}`;
}

function field(value: JsonValue, name: string): JsonValue | undefined {
	if (!isJsonObject(value))
		throw new Error(`expected an object containing ${name}`);
	return value[name];
}

function stringField(value: JsonValue, name: string): string {
	const result = field(value, name);
	if (!isJsonString(result)) throw new Error(`expected ${name} to be a string`);
	return result;
}

function arrayField(value: JsonValue, name: string): JsonValue[] {
	const result = field(value, name);
	if (!isJsonArray(result)) throw new Error(`expected ${name} to be an array`);
	return result;
}

function requiredHeader(value: string | string[] | undefined): string {
	if (Array.isArray(value)) {
		const first = value[0];
		if (first === undefined) throw new Error("expected a webhook header");
		return first;
	}
	if (value === undefined) throw new Error("expected a webhook header");
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

async function responseOf(response: Response): Promise<FakeResponse> {
	if (response.status === 204)
		return { status: response.status, headers: response.headers, body: null };
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
	if (body !== undefined) headers.set("content-type", "application/json");
	const response = await fetch(`${fake.baseUrl}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
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
			headers: {
				"content-type": "application/json",
				"x-agent37-key": apiKey,
			},
			body: JSON.stringify(body),
		},
	);
	return responseOf(response);
}

async function createInstance(
	fake: FakeAgent37Server,
	overrides: JsonObject = {},
): Promise<FakeResponse> {
	return api(fake, "POST", "/v1/instances", {
		...createRequest,
		...overrides,
	});
}

describe("Agent37 Sandbox API fake", () => {
	let fake: FakeAgent37Server;

	beforeEach(async () => {
		fake = await createAgent37FakeServer({ apiKey: generatedKey() });
	});

	afterEach(async () => {
		await fake.close();
	});

	it("creates, lists newest first, gets, and deletes instances without exposing env", async () => {
		const first = await createInstance(fake);
		expect(first.status).toBe(201);
		expect(first.body).toMatchObject({
			id: expect.any(String),
			name: "hobo-a37-test",
			resources: { cpu: 2, memory: 4, disk: 20 },
			status: "running",
			metadata: { hobo: "ci", leaseId: "lease-test" },
		});
		expect(first.body).not.toHaveProperty("env");
		const firstId = stringField(first.body, "id");

		const second = await createInstance(fake, { name: "hobo-a37-second" });
		const secondId = stringField(second.body, "id");
		const list = await api(fake, "GET", "/v1/instances");
		expect(list.status).toBe(200);
		expect(
			arrayField(list.body, "instances").map((entry) =>
				stringField(entry, "id"),
			),
		).toEqual([secondId, firstId]);

		const get = await api(fake, "GET", `/v1/instances/${firstId}`);
		expect(get.status).toBe(200);
		expect(stringField(get.body, "id")).toBe(firstId);

		expect((await api(fake, "DELETE", `/v1/instances/${firstId}`)).status).toBe(
			204,
		);
		expect((await api(fake, "GET", `/v1/instances/${firstId}`)).status).toBe(
			404,
		);
		expect(
			arrayField((await api(fake, "GET", "/v1/instances")).body, "instances"),
		).toHaveLength(1);
	});

	it("rejects wrong and missing keys on both API and exec planes without executing", async () => {
		const wrongKey = generatedKey();
		const list = await api(fake, "GET", "/v1/instances", undefined, wrongKey);
		expect(list.status).toBe(401);
		expect(list.body).toMatchObject({ error: { code: "unauthorized" } });

		const instanceId = stringField((await createInstance(fake)).body, "id");
		const command = await exec(
			fake,
			instanceId,
			{ command: "printf ready" },
			wrongKey,
		);
		expect(command.status).toBe(401);
		expect(command.body).toMatchObject({ error: { code: "unauthorized" } });

		const missing = await fetch(
			`${fake.baseUrl}/v1/instances/${instanceId}/exec`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ command: "printf missing" }),
			},
		);
		expect(missing.status).toBe(401);
		expect(await missing.json()).toMatchObject({
			error: { code: "unauthorized" },
		});
		expect(fake.state.execInvocations).toHaveLength(0);
	});

	it("returns 402 when the wallet cannot cover one day of the instance rate", async () => {
		fake.state.walletUsd = 0;
		const response = await createInstance(fake);
		expect(response.status).toBe(402);
		expect(response.body).toMatchObject({
			error: { code: "insufficient_balance" },
		});
		expect(fake.state.instances).toHaveLength(0);
	});

	it("enforces the running memory ceiling and releases it when an instance stops", async () => {
		fake.state.memoryLimitGb = 4;
		const first = await createInstance(fake);
		expect(first.status).toBe(201);
		const firstId = stringField(first.body, "id");

		const limited = await createInstance(fake, { name: "over-ceiling" });
		expect(limited.status).toBe(409);
		expect(limited.body).toMatchObject({
			error: { code: "instance_limit_reached" },
		});

		expect(
			(await api(fake, "POST", `/v1/instances/${firstId}/stop`, {})).status,
		).toBe(200);
		expect((await createInstance(fake, { name: "after-stop" })).status).toBe(
			201,
		);
	});

	it("returns 503 no_capacity for a full region", async () => {
		fake.state.regionsWithoutCapacity.add("us");
		const response = await createInstance(fake);
		expect(response.status).toBe(503);
		expect(response.body).toMatchObject({ error: { code: "no_capacity" } });
	});

	it("exposes injected 429 faults with Retry-After", async () => {
		fake.state.failNextRequest = {
			status: 429,
			code: "rate_limited",
			retryAfterSeconds: 3,
		};
		const response = await api(fake, "GET", "/v1/instances");
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("3");
		expect(response.body).toMatchObject({ error: { code: "rate_limited" } });
	});

	it("runs sync and background exec and replays names only inside five minutes", async () => {
		let now = new Date("2026-11-20T00:00:00.000Z");
		await fake.close();
		fake = await createAgent37FakeServer({
			apiKey: generatedKey(),
			now: () => now,
			execHandler: ({ command }) => ({
				stdout: `${command}\n`,
				stderr: "",
				exitCode: 0,
			}),
		});
		const instanceId = stringField((await createInstance(fake)).body, "id");

		const sync = await exec(fake, instanceId, {
			command: "printf ready",
			name: "prepare-lease",
		});
		expect(sync.status).toBe(200);
		expect(sync.body).toMatchObject({
			background: false,
			status: "completed",
			stdout: "printf ready\n",
		});
		const syncReplay = await exec(fake, instanceId, {
			command: "printf changed",
			name: "prepare-lease",
		});
		expect(syncReplay.body).toEqual(sync.body);
		expect(fake.state.execInvocations).toHaveLength(1);

		const background = await exec(fake, instanceId, {
			command: "./run.sh",
			background: true,
			name: "start-lease",
		});
		expect(background.body).toMatchObject({
			background: true,
			status: "running",
			exit_code: null,
			finished_at: null,
		});
		const backgroundReplay = await exec(fake, instanceId, {
			command: "./run.sh --changed",
			background: true,
			name: "start-lease",
		});
		expect(backgroundReplay.body).toEqual(background.body);
		expect(fake.state.execInvocations).toHaveLength(2);

		now = new Date(now.getTime() + 300_001);
		const expired = await exec(fake, instanceId, {
			command: "printf ready",
			name: "prepare-lease",
		});
		expect(stringField(expired.body, "id")).not.toBe(
			stringField(sync.body, "id"),
		);
		expect(fake.state.execInvocations).toHaveLength(3);
	});

	it("supports lifecycle, resize, and fork operations", async () => {
		const instanceId = stringField((await createInstance(fake)).body, "id");
		for (const [verb, status] of [
			["stop", "stopped"],
			["start", "running"],
			["sleep", "sleeping"],
			["start", "running"],
			["restart", "running"],
		] as const) {
			const response = await api(
				fake,
				"POST",
				`/v1/instances/${instanceId}/${verb}`,
				{},
			);
			expect(response.status).toBe(200);
			expect(stringField(response.body, "status")).toBe(status);
		}
		const update = await api(
			fake,
			"POST",
			`/v1/instances/${instanceId}/update`,
			{
				template: "agent37-base",
			},
		);
		expect(stringField(update.body, "template")).toBe("agent37-base");
		const resize = await api(
			fake,
			"POST",
			`/v1/instances/${instanceId}/resize`,
			{
				resources: { cpu: 4, memory: 8, disk: 30 },
			},
		);
		expect(resize.body).toMatchObject({
			resources: { cpu: 4, memory: 8, disk: 30 },
		});
		const fork = await api(fake, "POST", `/v1/instances/${instanceId}/fork`, {
			name: "forked",
		});
		expect(fork.status).toBe(201);
		expect(stringField(fork.body, "name")).toBe("forked");
	});

	it("rejects malformed JSON on fork and lifecycle routes", async () => {
		const instanceId = stringField((await createInstance(fake)).body, "id");
		for (const verb of ["fork", "stop"]) {
			const response = await fetch(
				`${fake.baseUrl}/v1/instances/${instanceId}/${verb}`,
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
			expect(await response.json()).toEqual({
				error: {
					code: "invalid_request",
					message: "request body must be JSON",
				},
			});
		}
	});

	it("rejects invalid resize disk values and defaults only an omitted disk", async () => {
		const instanceId = stringField((await createInstance(fake)).body, "id");
		for (const disk of [null, 0, -1, 1.5, 1025, "20"]) {
			const response = await api(
				fake,
				"POST",
				`/v1/instances/${instanceId}/resize`,
				{ resources: { cpu: 2, memory: 4, disk } },
			);
			expect(response.status).toBe(400);
			expect(response.body).toMatchObject({
				error: { code: "invalid_request" },
			});
		}
		const resize = await api(
			fake,
			"POST",
			`/v1/instances/${instanceId}/resize`,
			{ resources: { cpu: 4, memory: 8 } },
		);
		expect(resize.body).toMatchObject({
			resources: { cpu: 4, memory: 8, disk: 20 },
		});
	});

	it("returns a generic internal error without handler details", async () => {
		await fake.close();
		fake = await createAgent37FakeServer({
			apiKey: generatedKey(),
			execHandler: () => {
				throw new Error("private handler failure");
			},
		});
		const instanceId = stringField((await createInstance(fake)).body, "id");
		const response = await exec(fake, instanceId, { command: "printf ready" });
		expect(response.status).toBe(500);
		expect(response.body).toEqual({
			error: { code: "internal_error", message: "internal server error" },
		});
	});

	it("provides webhook CRUD and Standard Webhooks HMAC-SHA256 signatures", async () => {
		const received: ReceivedWebhook[] = [];
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
			if (!isTcpAddress(address)) throw new Error("expected a TCP listener");
			const registration = await api(fake, "POST", "/v1/webhooks", {
				url: `http://127.0.0.1:${address.port}/agent37`,
			});
			expect(registration.status).toBe(201);
			const webhookId = stringField(registration.body, "id");
			const secret = stringField(registration.body, "secret");
			expect(secret.startsWith("whsec_")).toBe(true);

			const instanceId = stringField((await createInstance(fake)).body, "id");
			expect(received).toHaveLength(1);
			const delivery = received[0];
			expect(delivery).toBeDefined();
			if (delivery === undefined) throw new Error("webhook was not delivered");
			const expectedSignature = `v1,${createHmac(
				"sha256",
				Buffer.from(secret.slice("whsec_".length), "base64"),
			)
				.update(`${delivery.id}.${delivery.timestamp}.${delivery.body}`)
				.digest("base64")}`;
			expect(delivery.signature).toBe(expectedSignature);
			expect(JSON.parse(delivery.body)).toMatchObject({
				type: "instance.status_changed",
				data: {
					previous_status: "provisioning",
					instance: { id: instanceId, status: "running" },
				},
			});
			expect(fake.state.webhookDeliveries[0]?.responseStatus).toBe(204);

			const list = await api(fake, "GET", "/v1/webhooks");
			expect(arrayField(list.body, "webhooks")).toHaveLength(1);
			expect(list.body).not.toHaveProperty("webhooks.0.secret");
			expect(
				(await api(fake, "DELETE", `/v1/webhooks/${webhookId}`)).status,
			).toBe(204);
			expect(
				arrayField((await api(fake, "GET", "/v1/webhooks")).body, "webhooks"),
			).toHaveLength(0);
		} finally {
			receiver.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				receiver.close((error) =>
					error === undefined ? resolve() : reject(error),
				);
			});
		}
	});
});
