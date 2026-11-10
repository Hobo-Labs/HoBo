import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ciEventSinkFromEnv, createCiEventEmitter } from "@hobo/ci-gh-actions";
import { getVercelOidcToken } from "@vercel/oidc";
import { type MessageMetadata, QueueClient } from "@vercel/queue";
import { createBootstrapEntry } from "./bootstrap-entry.js";
import { createVercelApplication } from "./composition.js";
import { reportRelayFailure, setRelayFailureEvents } from "./failure-log.js";
import { createNodeRelayHandler } from "./node-handler.js";
import { forwardQueueWakeup } from "./queue-forwarding.js";
import { loadBrokerRuntimeConfig } from "./runtime-config-client.js";
import { QueueMessageSchema } from "./worker.js";

// Keep Vercel's default deployment pinning: the callback hands each wakeup to
// the current production relay before acknowledging its original delivery.
const queue = new QueueClient();
// Public deployment addresses, pinned in source; neither is a credential.
const brokerOrigin =
	"https://br-morning-dust-b78xxqrk-hobocivault.compute.c-13.us-east-1.aws.neon.tech";
const brokerAudience = "https://hobo-ci.vercel.app/internal/runtime-config";
// Owner bootstrap requires converted-App metadata and browser identity checks.
const ownerBootstrapEnabled = true;
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
let startup: ReturnType<typeof createVercelApplication> | undefined;
function application() {
	const options = {
		env: process.env,
		notify: async (deliveryId: string) => {
			await queue.send("hobo-ci", { deliveryId }, { retentionSeconds: 3600 });
		},
		continueRepair: async () => {
			await queue.send(
				"hobo-ci",
				{ source: "hobo-ci", name: "hobo-ci-repair" },
				{
					delaySeconds: 60,
					retentionSeconds: 3600,
					idempotencyKey: `repair-${Math.floor(Date.now() / 60_000)}`,
				},
			);
		},
		scheduledRepair: async () => {
			await queue.send(
				"hobo-ci",
				{ source: "static", name: "hobo-ci-repair" },
				{ retentionSeconds: 3600 },
			);
		},
	};
	// Which step of startup was running when it failed: the log line names it.
	let stage = "runtime-config";
	startup ??= Promise.resolve()
		.then(async () => {
			let env = process.env;
			let ownerVerifiedBootstrap = false;
			if (
				env.VERCEL_ENV === "production" &&
				!env.HOBO_CI_BOOTSTRAP_TOKEN_SHA256 &&
				!env.HOBO_CI_GITHUB_APP_ID
			) {
				const config = await loadBrokerRuntimeConfig({
					origin: brokerOrigin,
					audience: brokerAudience,
					getToken: (audience) =>
						getVercelOidcToken({ audience, skipCache: true }),
				});
				env = { ...env, ...config };
				ownerVerifiedBootstrap = ownerBootstrapEnabled;
			}
			stage = "application";
			const resolved = { ...options, env };
			if (!env.HOBO_CI_BOOTSTRAP_TOKEN_SHA256)
				return createVercelApplication(resolved);
			const bootstrapOptions: Parameters<typeof createBootstrapEntry>[0] =
				resolved;
			if (ownerVerifiedBootstrap)
				bootstrapOptions.expectedGithubOwnerId = 145080887;
			return createBootstrapEntry(bootstrapOptions);
		})
		.catch((error) => {
			// Every request answers 503 until this succeeds; say why.
			reportRelayFailure(
				"hobo_ci_relay_init_failed",
				{ stage },
				error instanceof Error ? error : undefined,
			);
			startup = undefined;
			throw new Error("relay initialization failed");
		});
	return startup;
}

/** Vercel Node Function HTTP entrypoint. */
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
		try {
			const app = await load();
			await createNodeRelayHandler({ origin: app.origin, handle: app.handle })(
				request,
				response,
			);
		} catch {
			if (!response.headersSent)
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

/** Private Vercel queue trigger. The database remains the source of truth. */
export const consume = queue.handleNodeCallback(async (message, metadata) => {
	reportQueueBinding(metadata);
	if (process.env.VERCEL_ENV !== "production") {
		await (await application()).tick(QueueMessageSchema.parse(message));
		return;
	}
	let origin = process.env.HOBO_CI_PUBLIC_URL;
	let secret = process.env.CRON_SECRET;
	if (
		!process.env.HOBO_CI_BOOTSTRAP_TOKEN_SHA256 &&
		!process.env.HOBO_CI_GITHUB_APP_ID
	) {
		const config = await loadBrokerRuntimeConfig({
			origin: brokerOrigin,
			audience: brokerAudience,
			getToken: (audience) => getVercelOidcToken({ audience, skipCache: true }),
		});
		if (config.HOBO_CI_PUBLIC_URL !== new URL(brokerAudience).origin)
			throw new Error("queue handoff origin mismatch");
		origin = config.HOBO_CI_PUBLIC_URL;
		secret = config.CRON_SECRET;
	}
	if (!origin || !secret)
		throw new Error("queue handoff configuration unavailable");
	await forwardQueueWakeup({ origin, secret, message });
});
