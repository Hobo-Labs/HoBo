import { describe, expect, it } from "vitest";
import {
	authenticatedOwnerRun,
	ownerRequest,
} from "../../src/isolated-owner-wire.js";

const run = {
	id: "8d0f3c2e-1b4a-4c5d-9e6f-7a8b9c0d1e2f",
	secret: "A".repeat(43),
};
const request = {
	run,
	policy: {
		allowedOrigins: ["https://fixture.invalid"],
		allowInsecureLoopback: false,
		allowProxy: false,
		allowExtraCa: false,
	},
	url: "https://fixture.invalid/private",
	method: "POST",
	headers: [],
	redirect: "follow",
	cache: "default",
	credentials: "same-origin",
	integrity: "",
	keepalive: false,
	mode: "cors",
	referrer: "about:client",
	referrerPolicy: "",
	body: null,
	egress: {},
};

describe("private owner wire policy", () => {
	it("accepts an authenticated HTTPS request to an allowed origin", () => {
		const parsed = ownerRequest.parse(request);
		expect(authenticatedOwnerRun(parsed, run)).toBe(true);
		expect(authenticatedOwnerRun(parsed, { ...run, secret: "B".repeat(43) })).toBe(
			false,
		);
		expect(authenticatedOwnerRun(parsed, { ...run, id: crypto.randomUUID() })).toBe(
			false,
		);
	});

	it.each([
		{ url: "https://other.invalid/private" },
		{ url: "http://fixture.invalid/private" },
		{ url: "https://owner:secret@fixture.invalid/private" },
		{ egress: { proxy: "https://proxy.invalid" } },
		{ egress: { noProxy: "fixture.invalid" } },
		{ egress: { caFile: "/fixture/ca.pem" } },
		{ run: { ...run, secret: "" } },
	])("refuses a request outside its run or transport policy", (change) => {
		expect(ownerRequest.safeParse({ ...request, ...change }).success).toBe(false);
	});

	it("permits proxy and extra CA settings only with explicit policy", () => {
		expect(
			ownerRequest.safeParse({
				...request,
				policy: { ...request.policy, allowProxy: true, allowExtraCa: true },
				egress: { proxy: "https://proxy.invalid", caFile: "/fixture/ca.pem" },
			}).success,
		).toBe(true);
	});
});
