import { describe, expect, it } from "vitest";
import {
	BoundaryError,
	createCloudEventsWebhookSink,
	createMemoryDeadLetter,
	projectCdEvents,
	signWebhook,
	verifyWebhookSignature,
	WEBHOOK_SECRET_SCOPE,
	webhookBackoffMs,
} from "../../src/boundary/index.js";
import { CD_DEFAULTS } from "../../src/events.js";
import {
	credentials,
	recordingTelemetry,
	SECRET,
	scriptedHttp,
	status,
} from "./fakes.js";
import { fixtureJournal } from "./journal.js";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const event = projectCdEvents(fixtureJournal(), { source: "/hobo/cd/acme" })[3];
if (event === undefined) throw new Error("fixture");

function sink(
	http: ReturnType<typeof scriptedHttp>,
	extra: Record<string, unknown> = {},
) {
	const waits: number[] = [];
	const deadLetter = createMemoryDeadLetter();
	const telemetry = recordingTelemetry();
	const creds = credentials();
	const s = createCloudEventsWebhookSink({
		endpoint: "https://hooks.example/cd",
		http,
		credentials: creds,
		secretRef: "webhook/acme",
		now: () => NOW,
		sleep: async (ms) => {
			waits.push(ms);
		},
		deadLetter,
		telemetry,
		...extra,
	});
	return { s, waits, deadLetter, telemetry, creds };
}

describe("CloudEvents webhook sink (D17)", () => {
	it("uses the CloudEvents HTTP binary binding with the CDEvent as the body", async () => {
		const http = scriptedHttp([status(202)]);
		const { s } = sink(http);
		const result = await s.deliver(event);
		expect(result).toMatchObject({
			outcome: "delivered",
			attempts: 1,
			status: 202,
		});
		const request = http.requests[0];
		expect(request?.method).toBe("POST");
		expect(request?.url).toBe("https://hooks.example/cd");
		expect(request?.headers).toMatchObject({
			"content-type": "application/json",
			"ce-specversion": "1.0",
			"ce-id": event.context.id,
			"ce-source": event.context.source,
			"ce-type": event.context.type,
			"ce-subject": event.subject.id,
			"ce-time": event.context.timestamp,
		});
		expect(JSON.parse(request?.body ?? "")).toEqual(
			JSON.parse(JSON.stringify(event)),
		);
	});

	it("webhook signatures verify", async () => {
		const http = scriptedHttp([status(200)]);
		const { s, creds } = sink(http);
		await s.deliver(event);
		const request = http.requests[0];
		if (request?.body === undefined) throw new Error("no request");
		expect(creds.calls).toEqual([
			{ ref: "webhook/acme", scope: WEBHOOK_SECRET_SCOPE },
		]);
		expect(request.headers["webhook-id"]).toBe(event.context.id);
		expect(request.headers["webhook-timestamp"]).toBe(String(NOW / 1000));
		expect(request.headers["webhook-signature"]).toMatch(
			/^v1,[A-Za-z0-9+/]+=*$/u,
		);
		const verify = (
			overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]>,
		) =>
			verifyWebhookSignature({
				headers: request.headers,
				body: request.body ?? "",
				secret: SECRET,
				now: () => NOW,
				...overrides,
			});
		expect(() => verify({})).not.toThrow();
		expect(() => verify({ body: `${request.body} ` })).toThrow(
			/webhook-signature-invalid/,
		);
		expect(() => verify({ secret: "whsec_b3RoZXI=" })).toThrow(
			/webhook-signature-invalid/,
		);
		expect(() => verify({ now: () => NOW + 301_000 })).toThrow(
			/webhook-timestamp-stale/,
		);
		expect(() =>
			verify({
				headers: { ...request.headers, "webhook-signature": "v1,AAAA" },
			}),
		).toThrow(/webhook-signature-invalid/);
	});

	it("signs exactly the Standard Webhooks v1 content", () => {
		// HMAC-SHA256 over `${id}.${timestamp}.${body}` with the decoded whsec_ key.
		const a = signWebhook({
			id: "msg_1",
			timestampSeconds: 1,
			body: "{}",
			secret: "whsec_a2V5",
		});
		const b = signWebhook({
			id: "msg_1",
			timestampSeconds: 1,
			body: "{}",
			secret: "key",
		});
		expect(a).toBe(b);
		expect(a).not.toBe(
			signWebhook({
				id: "msg_2",
				timestampSeconds: 1,
				body: "{}",
				secret: "key",
			}),
		);
	});

	it("retries are bounded: 8 attempts with capped exponential backoff, then dead-letter", async () => {
		const http = scriptedHttp([status(503)]);
		const { s, waits, deadLetter, telemetry } = sink(http);
		const result = await s.deliver(event);
		expect(result).toMatchObject({
			outcome: "dead-lettered",
			attempts: CD_DEFAULTS.webhookMaxAttempts,
			status: 503,
			code: "webhook-retries-exhausted",
		});
		expect(http.requests).toHaveLength(CD_DEFAULTS.webhookMaxAttempts);
		expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000]);
		expect(deadLetter.entries()).toHaveLength(1);
		expect(deadLetter.entries()[0]).toMatchObject({
			endpoint: "https://hooks.example/cd",
			attempts: 8,
			code: "webhook-retries-exhausted",
		});
		expect(telemetry.points.map((p) => p.name)).toContain(
			"hobo.cd.boundary.webhook.dead_letters",
		);
		// A caller cannot raise the bound past the default.
		const capped = sink(scriptedHttp([status(500)]), { maxAttempts: 50 });
		expect((await capped.s.deliver(event)).attempts).toBe(
			CD_DEFAULTS.webhookMaxAttempts,
		);
	});

	it("caps backoff at 5 minutes and honours Retry-After within the cap", async () => {
		expect(webhookBackoffMs(20, 1_000, 300_000)).toBe(300_000);
		const http = scriptedHttp([
			status(429, { "retry-after": "30" }),
			status(429, { "Retry-After": "9999" }),
			status(200),
		]);
		const { s, waits } = sink(http);
		expect((await s.deliver(event)).outcome).toBe("delivered");
		expect(waits).toEqual([30_000, 300_000]);
	});

	it("retries transport errors and succeeds", async () => {
		const http = scriptedHttp([new Error("ECONNRESET"), status(204)]);
		const { s } = sink(http);
		expect(await s.deliver(event)).toMatchObject({
			outcome: "delivered",
			attempts: 2,
		});
	});

	it("dead-letters a non-retryable 4xx at once", async () => {
		const http = scriptedHttp([status(401)]);
		const { s, deadLetter, waits } = sink(http);
		expect(await s.deliver(event)).toMatchObject({
			outcome: "dead-lettered",
			attempts: 1,
			code: "webhook-rejected",
		});
		expect(waits).toEqual([]);
		expect(deadLetter.entries()[0]?.status).toBe(401);
	});

	it("never sends unsigned: a missing secret fails closed before any request", async () => {
		const http = scriptedHttp([status(200)]);
		const s = createCloudEventsWebhookSink({
			endpoint: "https://hooks.example/cd",
			http,
			credentials: credentials(null),
			secretRef: "webhook/missing",
			now: () => NOW,
		});
		await expect(s.deliver(event)).rejects.toMatchObject({
			code: "webhook-secret-missing",
		});
		expect(http.requests).toHaveLength(0);
	});

	it("refuses an insecure or credentialed endpoint", () => {
		const base = {
			http: scriptedHttp([]),
			credentials: credentials(),
			secretRef: "r",
			now: () => NOW,
		};
		expect(() =>
			createCloudEventsWebhookSink({
				...base,
				endpoint: "http://hooks.example/cd",
			}),
		).toThrow(BoundaryError);
		expect(() =>
			createCloudEventsWebhookSink({
				...base,
				endpoint: "https://u:p@hooks.example/cd",
			}),
		).toThrow(/webhook-endpoint-invalid/);
		expect(() =>
			createCloudEventsWebhookSink({
				...base,
				endpoint: "http://hooks.example/cd",
				allowInsecureHttp: true,
			}),
		).toThrow(/webhook-endpoint-invalid/);
		expect(() =>
			createCloudEventsWebhookSink({
				...base,
				endpoint: "http://127.0.0.1:8080/cd",
				allowInsecureHttp: true,
			}),
		).not.toThrow();
	});
});
