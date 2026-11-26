import { describe, expect, it } from "vitest";

import {
	DEFAULT_MESSAGING_POLICY_PACK,
	evaluateMessagingPolicy,
} from "../src/messaging-policy-pack.js";

describe("messaging policy pack", () => {
	it("requires exactly-once in prod", () => {
		const r = evaluateMessagingPolicy({
			environment: "prod",
			delivery: "at-least-once",
			runtime: "local",
			topicCount: 1,
			publisherTenant: "a",
			consumerTenant: "a",
		});
		expect(r.allowed).toBe(false);
		expect(r.reasons[0]).toMatch(/exactly-once/);
	});

	it("denies dapr in regulated env", () => {
		const r = evaluateMessagingPolicy({
			pack: DEFAULT_MESSAGING_POLICY_PACK,
			environment: "air-gap",
			delivery: "exactly-once",
			runtime: "dapr",
			topicCount: 1,
			publisherTenant: "a",
			consumerTenant: "a",
		});
		expect(r.allowed).toBe(false);
		expect(r.reasons.some((x) => /Dapr/.test(x))).toBe(true);
	});

	it("denies cross-tenant messaging", () => {
		const r = evaluateMessagingPolicy({
			environment: "dev",
			delivery: "at-least-once",
			runtime: "local",
			topicCount: 1,
			publisherTenant: "a",
			consumerTenant: "b",
		});
		expect(r.allowed).toBe(false);
	});

	it("allows happy path", () => {
		const r = evaluateMessagingPolicy({
			environment: "dev",
			delivery: "at-least-once",
			runtime: "local",
			topicCount: 2,
			publisherTenant: "a",
			consumerTenant: "a",
		});
		expect(r.allowed).toBe(true);
	});
});
