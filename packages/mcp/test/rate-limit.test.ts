import { afterEach, describe, expect, it } from "vitest";
import {
	createRateLimiter,
	type RateLimitDecision,
	rateLimitKey,
} from "../src/rate-limit.js";
import { createHoboMcpServer } from "../src/server.js";
import {
	authGranting,
	closeStores,
	HELLO_BINDLE,
	makeWiredCli,
	withProject,
} from "./helpers.js";

afterEach(() => closeStores());

// S3-06 — per-principal / per-tenant rate limits + quotas with typed
// backpressure at the tool-call boundary (NFR-019). Time is injected, so every
// decision is deterministic.

const flooder = { kind: "agent", id: "flooder" };
const control = { kind: "agent", id: "control" };

describe("token-bucket + quota limiter (pure, injected clock)", () => {
	it("allows a burst up to capacity, then throttles with reason 'rate'", () => {
		const limiter = createRateLimiter({
			capacity: 2,
			refillTokens: 1,
			refillIntervalMs: 1000,
		});
		const at = (now: number) =>
			limiter.check({ tenant: "acme", principal: flooder, now });

		expect(at(0).allowed).toBe(true);
		expect(at(0).allowed).toBe(true);
		const throttled = at(0);
		expect(throttled.allowed).toBe(false);
		expect(throttled.reason).toBe("rate");
		expect(throttled.retryAfterMs).toBeGreaterThan(0);
	});

	it("refills lazily from elapsed injected time", () => {
		const limiter = createRateLimiter({
			capacity: 1,
			refillTokens: 1,
			refillIntervalMs: 1000,
		});
		expect(
			limiter.check({ tenant: "acme", principal: flooder, now: 0 }).allowed,
		).toBe(true);
		expect(
			limiter.check({ tenant: "acme", principal: flooder, now: 0 }).allowed,
		).toBe(false);
		// One interval later, a token has refilled.
		expect(
			limiter.check({ tenant: "acme", principal: flooder, now: 1000 }).allowed,
		).toBe(true);
	});

	it("enforces the fixed-window quota with reason 'quota'", () => {
		const limiter = createRateLimiter({
			capacity: 100,
			refillTokens: 100,
			refillIntervalMs: 1000,
			quota: { limit: 3, windowMs: 60_000 },
		});
		const at = (now: number) =>
			limiter.check({ tenant: "acme", principal: flooder, now });
		expect(at(0).allowed).toBe(true);
		expect(at(0).allowed).toBe(true);
		expect(at(0).allowed).toBe(true);
		const quotaHit = at(0);
		expect(quotaHit.allowed).toBe(false);
		expect(quotaHit.reason).toBe("quota");
		// The window rolls after windowMs.
		expect(at(60_000).allowed).toBe(true);
	});

	it("isolates per (tenant, principal) — a flood never starves a control principal", () => {
		const limiter = createRateLimiter({
			capacity: 1,
			refillTokens: 1,
			refillIntervalMs: 1000,
		});
		expect(
			limiter.check({ tenant: "acme", principal: flooder, now: 0 }).allowed,
		).toBe(true);
		expect(
			limiter.check({ tenant: "acme", principal: flooder, now: 0 }).allowed,
		).toBe(false);
		// The control principal has its own untouched bucket.
		expect(
			limiter.check({ tenant: "acme", principal: control, now: 0 }).allowed,
		).toBe(true);
		// Same principal id under a different tenant is also a distinct key.
		expect(rateLimitKey("acme", flooder)).not.toBe(
			rateLimitKey("beta", flooder),
		);
		expect(
			limiter.check({ tenant: "beta", principal: flooder, now: 0 }).allowed,
		).toBe(true);
	});

	it("is deterministic — identical clock sequences decide identically", () => {
		const run = (): RateLimitDecision[] => {
			const limiter = createRateLimiter({
				capacity: 2,
				refillTokens: 1,
				refillIntervalMs: 1000,
				quota: { limit: 4, windowMs: 60_000 },
			});
			const nows = [0, 0, 0, 500, 1000, 1000, 2000];
			return nows.map((now) =>
				limiter.check({ tenant: "acme", principal: flooder, now }),
			);
		};
		expect(run()).toEqual(run());
	});
});

describe("server applies backpressure BEFORE dispatch", () => {
	it("throttles a flooding principal with a typed error while a control principal is unaffected", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			// Frozen clock: no refill, so capacity is the whole burst budget.
			const server = createHoboMcpServer({
				cli: makeWiredCli(),
				rateLimit: { capacity: 2, refillTokens: 1, refillIntervalMs: 1000 },
				clock: () => 1000,
			});
			const flooderAuth = authGranting(["plan"], { subject: "flooder" });
			const controlAuth = authGranting(["plan"], { subject: "control" });

			// The flooder gets its capacity, then is throttled.
			expect((await server.callTool("plan", { cwd }, flooderAuth)).ok).toBe(
				true,
			);
			expect((await server.callTool("plan", { cwd }, flooderAuth)).ok).toBe(
				true,
			);
			const throttled = await server.callTool("plan", { cwd }, flooderAuth);
			expect(throttled.ok).toBe(false);
			expect(throttled.status).toBe("throttled");
			expect(throttled.code).toBe("MCP_RATE_LIMITED");
			expect(throttled.error?.code).toBe("MCP_RATE_LIMITED");
			// Fail-closed: no dispatch ran, output is inert null, no scope decision.
			expect(throttled.output).toBeNull();
			expect(throttled.decision).toBeUndefined();

			// The control principal, in the same window, is unaffected.
			const controlResult = await server.callTool("plan", { cwd }, controlAuth);
			expect(controlResult.ok).toBe(true);

			// The throttle is an audited, never-compact credential fact.
			const events = server.getRateLimitEvents();
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("mcp.ToolCallThrottled");
			expect(events[0]?.data.subject).toBe("flooder");
			expect(events[0]?.data.reason).toBe("rate");
			expect(events[0]?.retention.neverCompact).toBe(true);
		});
	});

	it("never throttles when no rate-limit policy is configured", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const server = createHoboMcpServer({ cli: makeWiredCli() });
			const auth = authGranting(["plan"]);
			for (let i = 0; i < 10; i += 1) {
				expect((await server.callTool("plan", { cwd }, auth)).ok).toBe(true);
			}
			expect(server.getRateLimitEvents()).toHaveLength(0);
		});
	});
});
