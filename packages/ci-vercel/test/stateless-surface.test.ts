/**
 * The stateless relay's own routes and queue kinds, over the in-memory
 * harness: the authenticated queue handoff and cron tick, the MCP status
 * tool, the onboarding fallthrough, and the queue kinds a preview or an older
 * relay sends.
 */
import { describe, expect, it } from "vitest";
import {
	encodeRelayQueueMessage,
	RELAY_QUEUE_TOPICS,
} from "../src/relay-queue.js";
import { ORIGIN, openStatelessRelay } from "./stateless-harness.js";

/** One JSON-RPC tool call to the relay's MCP endpoint. */
type ToolCall = {
	jsonrpc: "2.0";
	id: number;
	method: "tools/call";
	params: { name: string; arguments: Readonly<Record<string, string>> };
};
const mcp = (token: string, body: ToolCall) =>
	new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});

describe("the stateless relay's internal routes", () => {
	it("runs a repair tick handed over on /internal/queue-wakeup, and refuses one without the cron secret", async () => {
		const h = await openStatelessRelay();
		const body = JSON.stringify(
			encodeRelayQueueMessage({
				kind: "repair",
				source: "static",
				platformSchedule: false,
			}),
		);
		const refused = await h.relay.handle(
			new Request(`${ORIGIN}/internal/queue-wakeup`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			}),
		);
		expect(refused.status).toBe(403);
		const taken = await h.relay.handle(
			new Request(`${ORIGIN}/internal/queue-wakeup`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${h.entries.CRON_SECRET}`,
				},
				body,
			}),
		);
		expect(taken.status).toBeLessThan(300);
	});

	it("enqueues a repair on the cron tick, and only with the cron secret", async () => {
		const h = await openStatelessRelay();
		const before = h.sent.length;
		expect(
			(await h.relay.handle(new Request(`${ORIGIN}/internal/tick`))).status,
		).toBe(403);
		const tick = await h.relay.handle(
			new Request(`${ORIGIN}/internal/tick`, {
				headers: { authorization: `Bearer ${h.entries.CRON_SECRET}` },
			}),
		);
		expect(tick.status).toBe(204);
		expect(h.sent.slice(before)).toEqual([
			{ topic: RELAY_QUEUE_TOPICS.repair, options: { retentionSeconds: 3600 } },
		]);
	});

	it("refuses an onboarding path it does not serve", async () => {
		const h = await openStatelessRelay();
		const response = await h.relay.handle(
			new Request(`${ORIGIN}/v1/app-bootstrap/nothing-here`),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
	});

	it("reports its readiness through the MCP status tool", async () => {
		const h = await openStatelessRelay();
		const response = await h.relay.handle(
			mcp(h.token, {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_relay_status", arguments: {} },
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("ready");
	});
});

describe("the stateless relay's queue kinds", () => {
	it("acknowledges a scheduled repair unworked off production, and a legacy wakeup with a log line", async () => {
		const h = await openStatelessRelay();
		const requests = h.github.requests.length;
		await h.relay.run({
			kind: "repair",
			source: "static",
			platformSchedule: true,
		});
		expect(h.github.requests.length).toBe(requests);
		await h.relay.run({ kind: "wakeup", deliveryId: "delivery-legacy" });
		expect(h.lines.map((line) => line.event)).toContain(
			"hobo_ci_legacy_wakeup_acknowledged",
		);
	});

	it("repairs on a manual message, and closes its cache", async () => {
		const h = await openStatelessRelay();
		await h.relay.run({ kind: "manual" });
		expect(h.github.requests.length).toBeGreaterThan(0);
		await h.relay.close();
	});
});
