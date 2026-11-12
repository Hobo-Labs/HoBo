import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonValue } from "@bufbuild/protobuf";
import {
	ciEventSinkFromEnv,
	createCiEventEmitter,
	createNodeRelayHandler,
	reportRelayFailure,
	setRelayFailureEvents,
} from "@hobo/ci-gh-actions";
import {
	type MessageMetadata,
	QueueClient,
	type RetryHandler,
} from "@vercel/queue";
import {
	forwardQueueHandoff,
	QueueHandoffError,
	redeliverRefusedWakeup,
} from "./queue-forwarding.js";
import {
	encodeRelayQueueMessage,
	parseRelayQueueMessage,
	type RelayQueueSend,
} from "./relay-queue.js";
import {
	createRelayRuntimeConfigLoader,
	type RelayConfigSource,
	type RelayRuntimeConfigLoader,
	relayConfigSourceFromEnv,
} from "./relay-runtime-config.js";
import { streamsBody } from "./relay-streams.js";
import { composeStatelessRelay } from "./stateless-composition.js";

// Keep Vercel's default deployment pinning: the callback hands each message
// to the current production relay before acknowledging its original delivery.
const queue = new QueueClient();
const send: RelayQueueSend = async (topic, payload, options) => {
	await queue.send(topic, payload, options);
};
// With HOBO_CI_EVENTS_URL set, each relay failure is also a CloudEvent.
setRelayFailureEvents(
	createCiEventEmitter({
		source: {
			tenant: process.env.HOBO_CI_EVENTS_TENANT || "hobo-ci",
			// One ordered stream per function instance of a deployment.
			streamId: `ci-relay/${process.env.VERCEL_DEPLOYMENT_ID || "local"}/${randomBytes(4).toString("hex")}`,
			actorId: "hobo-ci-relay",
		},
		sink: ciEventSinkFromEnv(process.env).sink,
	}),
);

/** When the config service last failed a refresh; cleared by the next success. */
let configStaleSince: number | undefined;
let loader:
	| { kind: RelayConfigSource["kind"]; config: RelayRuntimeConfigLoader }
	| undefined;
/**
 * The relay's configuration and secrets, from the config service the
 * deployment names (`HOBO_CI_CONFIG_SERVICE`: `infisical`, or `env`). One
 * loader per instance, shared by the HTTP entry and the queue consumer.
 */
function configLoader() {
	if (loader) return loader;
	const source = relayConfigSourceFromEnv(process.env);
	const tracked: RelayConfigSource = {
		kind: source.kind,
		async read() {
			const entries = await source.read();
			configStaleSince = undefined;
			return entries;
		},
	};
	loader = {
		kind: source.kind,
		config: createRelayRuntimeConfigLoader({
			source: tracked,
			onRefreshFailed: (error) => {
				configStaleSince ??= Date.now();
				reportRelayFailure(
					"hobo_ci_config_refresh_failed",
					{ configService: source.kind },
					error,
				);
			},
		}),
	};
	return loader;
}

let startup: ReturnType<typeof composeStatelessRelay> | undefined;
function application() {
	startup ??= Promise.resolve()
		.then(() => {
			const { kind, config } = configLoader();
			return composeStatelessRelay({
				env: process.env,
				config,
				configService: kind,
				configStaleSince: () => configStaleSince,
				send,
			});
		})
		.catch((error) => {
			// Every request but /healthz answers 503 until this succeeds; say why.
			reportRelayFailure(
				"hobo_ci_relay_init_failed",
				{ stage: "stateless" },
				error instanceof Error ? error : undefined,
			);
			startup = undefined;
			throw new Error("relay initialization failed");
		});
	return startup;
}

/**
 * Vercel Node Function HTTP entrypoint. `/healthz` answers 200 whatever the
 * relay's state (the process is up); everything else waits for the relay,
 * and answers 503 while it cannot start (`/readyz` says so in its body).
 */
export function createHttpEntry(
	load: () => Promise<{
		origin: string;
		handle: (request: Request) => Promise<Response>;
	}>,
) {
	return async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		const path = (request.url ?? "/").split("?")[0];
		if (request.method === "GET" && path === "/healthz") {
			response.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			});
			response.end(JSON.stringify({ ok: true }));
			return;
		}
		try {
			const app = await load();
			await createNodeRelayHandler({
				origin: app.origin,
				handle: app.handle,
				streams: streamsBody,
			})(request, response);
		} catch {
			if (response.headersSent) {
				response.end();
				return;
			}
			if (request.method === "GET" && path === "/readyz") {
				response.writeHead(503, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				});
				response.end(
					JSON.stringify({
						ready: false,
						// The relay could not start: the config service, the
						// configuration or the cache binding; the log names which.
						started: false,
					}),
				);
				return;
			}
			response.writeHead(503, { "Cache-Control": "no-store" });
			response.end();
		}
	};
}
export const http = createHttpEntry(application);

let queueBindingReported = false;
/** Emit bounded routing metadata once per instance; message payloads and
 * receipt handles stay private. A failed logger never changes queue behavior. */
export function reportQueueBinding(metadata: MessageMetadata) {
	if (
		queueBindingReported ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(metadata.topicName) ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(metadata.consumerGroup)
	)
		return;
	try {
		console.info(
			JSON.stringify({
				event: "hobo_ci_queue_binding",
				topic: metadata.topicName,
				consumerGroup: metadata.consumerGroup,
			}),
		);
		queueBindingReported = true;
	} catch {
		// Logging must not alter acknowledgement or retry behavior.
	}
}

/**
 * What the queue does with a message this callback failed to hand over.
 *
 * A relay that answered 503 gets the message again after a delay the queue
 * itself holds (`redeliverRefusedWakeup`). Thrown straight back, production
 * redelivered each message about every 15 s for as long as the relay was
 * down. The queue client reports nothing for a rescheduled message, so the
 * one line that names the status is written here.
 */
export const retryQueueWakeup: RetryHandler = (error, metadata) => {
	const directive = redeliverRefusedWakeup(error, metadata);
	if (directive && "afterSeconds" in directive)
		reportRelayFailure(
			"hobo_ci_queue_handoff_deferred",
			{
				status: error instanceof QueueHandoffError ? error.status : 0,
				afterSeconds: directive.afterSeconds,
				deliveryCount: metadata.deliveryCount,
			},
			error instanceof Error ? error : undefined,
		);
	return directive;
};

/**
 * One queue message, from any of the relay's topics (intake, lease steps,
 * repair). Off production it runs here. In production it is handed to the
 * current production relay (`/internal/queue-wakeup`, authenticated with
 * `CRON_SECRET` from the config service), so a message an older deployment
 * consumes still runs the newest code; that handler drops a failed repair
 * tick and holds a failed delivery or lease step for redelivery.
 */
async function queueCallback(
	message: JsonValue,
	metadata: MessageMetadata,
): Promise<void> {
	reportQueueBinding(metadata);
	const parsed = parseRelayQueueMessage(message);
	if (process.env.VERCEL_ENV !== "production") {
		await (await application()).run(parsed);
		return;
	}
	const config = await configLoader().config.load();
	await forwardQueueHandoff({
		origin: config.HOBO_CI_PUBLIC_URL,
		secret: config.CRON_SECRET,
		body: encodeRelayQueueMessage(parsed),
	});
}

/**
 * Register the queue callback on `client` together with its redelivery
 * policy. A function of the client so a test can see what is registered.
 */
export function registerQueueConsumer(
	client: Pick<QueueClient, "handleNodeCallback">,
) {
	return client.handleNodeCallback<JsonValue>(queueCallback, {
		retry: retryQueueWakeup,
	});
}

/** Private Vercel queue trigger, one function per topic (`vercel.json`). */
export const consume = registerQueueConsumer(queue);
