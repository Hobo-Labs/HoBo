/**
 * The Vercel entry's own wiring, with the composed relay and the config
 * service stood in: one config loader per instance, a failed start answered
 * 503 and retried, a queue message run here off production and handed to the
 * production relay in production.
 */
import { createServer } from "node:http";
import type { JsonValue } from "@bufbuild/protobuf";
import { type MessageMetadata, QueueClient } from "@vercel/queue";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { z } from "zod";
import { http, registerQueueConsumer, retryQueueWakeup } from "../src/entry.js";
import * as forwarding from "../src/queue-forwarding.js";
import { QueueHandoffError } from "../src/queue-forwarding.js";
import type { RelayQueueSend } from "../src/relay-queue.js";
import * as runtimeConfig from "../src/relay-runtime-config.js";
import * as composition from "../src/stateless-composition.js";

/** The config service the entry reads. */
let refreshFailed: ((error: Error) => void) | undefined;
const config = { reads: 0 };
vi.spyOn(runtimeConfig, "relayConfigSourceFromEnv").mockImplementation(() => ({
	kind: "env",
	read: async () => {
		config.reads++;
		return {};
	},
}));
vi.spyOn(runtimeConfig, "createRelayRuntimeConfigLoader").mockImplementation(
	(options) => {
		refreshFailed = options.onRefreshFailed;
		return {
			load: async () => {
				await options.source.read();
				// SAFETY: the entry reads only these two keys of the configuration.
				return {
					HOBO_CI_PUBLIC_URL: "https://relay.example.test",
					CRON_SECRET: "cron-secret",
				} as never;
			},
			invalidate: () => undefined,
		};
	},
);

/** The relay the entry composes; it refuses to start until told otherwise. */
type ComposedRelay = {
	send: RelayQueueSend;
	configStaleSince: () => number | undefined;
};
const composed: ComposedRelay[] = [];
const relay = {
	fail: true,
	composed,
	run: vi.fn(async () => undefined),
};
vi.spyOn(composition, "composeStatelessRelay").mockImplementation(
	async (options) => {
		await options.config.load();
		if (relay.fail) throw new Error("cache binding refused");
		relay.composed.push({
			send: options.send,
			configStaleSince: () => options.configStaleSince?.(),
		});
		// SAFETY: the entry uses only origin, handle and run of the relay.
		return {
			origin: "https://relay.example.test",
			handle: async (request: Request) =>
				new Response(`relay ${new URL(request.url).pathname}`),
			run: relay.run,
		} as never;
	},
);

/** What the entry handed to the production relay. */
const forwarded: Parameters<typeof forwarding.forwardQueueHandoff>[0][] = [];
vi.spyOn(forwarding, "forwardQueueHandoff").mockImplementation(
	async (options) => {
		forwarded.push(options);
	},
);

const server = createServer(http);
let base = "";
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});
const env = process.env.VERCEL_ENV;
afterEach(() => {
	if (env === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = env;
});

const metadata: MessageMetadata = {
	messageId: "msg_1",
	deliveryCount: 2,
	createdAt: new Date(0),
	expiresAt: new Date(86_400_000),
	topicName: "hobo-ci-repair",
	consumerGroup: "relay",
	region: "iad1",
};

/** The queue callback the entry registers. */
function callback() {
	let registered:
		| ((message: JsonValue, metadata: MessageMetadata) => Promise<void>)
		| undefined;
	const client = new QueueClient({
		region: "iad1",
		token: "queue-test-token",
		deploymentId: "dpl_test",
	});
	registerQueueConsumer({
		handleNodeCallback: (handler, options) => {
			registered = handler;
			return client.handleNodeCallback(handler, options);
		},
	});
	if (!registered) throw new Error("no callback registered");
	return registered;
}

/** Run `body` with the relay's failure log silenced. */
async function quietly(body: () => Promise<void> | void) {
	const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await body();
	} finally {
		log.mockRestore();
	}
}

describe("the relay entry", () => {
	it("answers /healthz while the relay cannot start, and 503 elsewhere with the reason on /readyz", async () => {
		await quietly(async () => {
			expect((await fetch(`${base}/healthz`)).status).toBe(200);
			const ready = await fetch(`${base}/readyz`);
			expect(ready.status).toBe(503);
			expect(await ready.json()).toEqual({ ready: false, started: false });
			expect((await fetch(`${base}/github/webhooks`)).status).toBe(503);
		});
	});

	it("retries the start on the next request, sharing one config loader", async () => {
		relay.fail = false;
		const reads = config.reads;
		const response = await fetch(`${base}/v1/anything`);
		expect(await response.text()).toBe("relay /v1/anything");
		expect(config.reads).toBe(reads + 1);
		// The composed relay's queue sender is the Vercel queue client, which
		// refuses to send outside a deployment that holds its OIDC token.
		const send = relay.composed[0]?.send;
		if (!send) throw new Error("the relay was not composed");
		await expect(
			send("hobo-ci-repair", null, { delaySeconds: 1 }),
		).rejects.toThrow();
	});

	it("marks the config stale when a refresh fails, until the next good read", async () => {
		const composed = relay.composed[0];
		await quietly(async () => {
			refreshFailed?.(new Error("config service down"));
			expect(composed?.configStaleSince()).toBeTypeOf("number");
			process.env.VERCEL_ENV = "production";
			await callback()(null, metadata);
			expect(composed?.configStaleSince()).toBeUndefined();
		});
	});

	it("runs a queue message here off production", async () => {
		process.env.VERCEL_ENV = "preview";
		relay.run.mockClear();
		await callback()(null, metadata);
		expect(relay.run).toHaveBeenCalledWith({ kind: "manual" });
	});

	it("hands a queue message to the production relay in production", async () => {
		process.env.VERCEL_ENV = "production";
		forwarded.length = 0;
		relay.run.mockClear();
		await callback()(null, metadata);
		expect(relay.run).not.toHaveBeenCalled();
		expect(forwarded).toEqual([
			{
				origin: "https://relay.example.test",
				secret: "cron-secret",
				body: null,
			},
		]);
	});

	it("defers a refused handoff on the queue, naming only the status", async () => {
		await quietly(() => {
			const directive = retryQueueWakeup(
				new QueueHandoffError(503, 30),
				metadata,
			);
			expect(directive).toMatchObject({ afterSeconds: expect.any(Number) });
			expect(retryQueueWakeup(new Error("other"), metadata)).not.toEqual(
				expect.objectContaining({ afterSeconds: expect.anything() }),
			);
		});
	});
});
