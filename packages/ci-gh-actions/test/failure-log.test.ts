import { describe, expect, it } from "vitest";
import {
	createFailureLog,
	describeFailure,
	failureRoute,
} from "../src/failure-log.js";
import { createRelayHandler } from "../src/http-handler.js";

function capture(now = () => 0) {
	const lines: string[] = [];
	const report = createFailureLog({
		write: (line) => lines.push(line),
		now,
	});
	return { report, lines, events: () => lines.map((line) => JSON.parse(line)) };
}

describe("describeFailure", () => {
	it("names the error and its cause", () => {
		expect(
			describeFailure(
				new TypeError("fetch failed", {
					cause: new Error("connect ECONNREFUSED 10.0.0.5:5432"),
				}),
			),
		).toEqual({
			error: "TypeError",
			message: "fetch failed",
			cause: "Error: connect ECONNREFUSED 10.0.0.5:5432",
		});
		expect(describeFailure(undefined)).toEqual({
			error: "unknown",
			message: "",
			cause: "",
		});
	});

	it("removes credentials and anything shaped like a token", () => {
		const failure = describeFailure(
			new Error(
				"cannot reach postgres://relay:hunter2@db.example/ci with key synthetic-relay-key-0123456789abcdef",
			),
		);
		expect(failure.message).not.toMatch(/hunter2|synthetic-relay-key/);
		expect(failure.message).toContain("//[redacted]@db.example/ci");
		expect(describeFailure(new Error("x".repeat(900))).message.length).toBe(10);
		expect(
			describeFailure(new Error(`${"word ".repeat(200)}`)).message.length,
		).toBe(300);
	});
});

describe("failureRoute", () => {
	it("drops the query and replaces identifiers", () => {
		expect(failureRoute("/v1/leases/9a1b2c3d/claim?token=abc")).toBe(
			"/v1/leases/{id}/claim",
		);
		expect(failureRoute("/v2/accounts/self/inbox/quarantined")).toBe(
			"/v2/accounts/self/inbox/quarantined",
		);
		expect(failureRoute(undefined)).toBe("");
	});
});

describe("createFailureLog", () => {
	it("writes one line per event per window and counts what it held back", () => {
		let clock = 0;
		const { report, events } = capture(() => clock);
		report(
			"hobo_ci_relay_init_failed",
			{ stage: "application" },
			new Error("a"),
		);
		report(
			"hobo_ci_relay_init_failed",
			{ stage: "application" },
			new Error("b"),
		);
		report("hobo_ci_control_failed", { route: "/v1/x" }, new Error("c"));
		clock = 10_000;
		report(
			"hobo_ci_relay_init_failed",
			{ stage: "application" },
			new Error("d"),
		);
		expect(events()).toEqual([
			{
				event: "hobo_ci_relay_init_failed",
				stage: "application",
				error: "Error",
				message: "a",
				cause: "",
				suppressed: 0,
			},
			{
				event: "hobo_ci_control_failed",
				route: "/v1/x",
				error: "Error",
				message: "c",
				cause: "",
				suppressed: 0,
			},
			{
				event: "hobo_ci_relay_init_failed",
				stage: "application",
				error: "Error",
				message: "d",
				cause: "",
				suppressed: 1,
			},
		]);
	});

	it("also emits each line as an event and flushes it at once", () => {
		const emitted: { name: string; fields: unknown }[] = [];
		let flushes = 0;
		const report = createFailureLog({
			write: () => undefined,
			now: () => 0,
			events: () => ({
				emit: (name, fields) => emitted.push({ name, fields }),
				flush: async () => {
					flushes += 1;
				},
			}),
		});
		report(
			"hobo_ci_relay_request_failed",
			{ method: "POST", route: "/github/webhooks" },
			new Error("bootstrap store initialization failed", {
				cause: new Error("Your account or project has exceeded the quota."),
			}),
		);
		// Held back by the window: no line, so no event either.
		report("hobo_ci_relay_request_failed", { method: "GET" }, new Error("x"));
		expect(emitted).toEqual([
			{
				name: "hobo_ci_relay_request_failed",
				fields: {
					method: "POST",
					route: "/github/webhooks",
					error: "Error",
					message: "bootstrap store initialization failed",
					cause: "Error: Your account or project has exceeded the quota.",
					suppressed: 0,
				},
			},
		]);
		expect(flushes).toBe(1);
	});

	it("never throws when the writer does", () => {
		const report = createFailureLog({
			write: () => {
				throw new Error("stderr closed");
			},
		});
		expect(() => report("event", {}, new Error("x"))).not.toThrow();
	});
});

describe("relay handler", () => {
	it("still answers 503 with a fixed body when the control plane throws", async () => {
		const handle = createRelayHandler({
			// Only `control` is reached by this request.
			application: {
				ready: async () => true,
				ingestWebhook: async () => "accepted",
				claim: async () => new Response(null, { status: 204 }),
				control: async () => {
					throw new Error("password authentication failed for user relay");
				},
			},
			webhookSecret: "s".repeat(32),
		});
		const response = await handle(
			new Request("https://ci.example.test/v1/accounts/self/policy"),
		);
		expect(response.status).toBe(503);
		// The reason goes to the log, never to the caller.
		expect(await response.text()).toBe('{"error":"service unavailable"}');
	});
});
