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
	maxResponseBytes: 1024,
	allowInsecureLoopback: false,
	trustedCertificates: [],
	egress: {},
};

describe("private owner wire policy", () => {
	it("accepts an authenticated run", () => {
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
		{ url: "not a url" },
		{ method: "" },
		{ run: { ...run, secret: "" } },
		{ run: { ...run, id: "not-a-uuid" } },
		{ maxResponseBytes: -1 },
		{ trustedCertificates: ["x".repeat(70_000)] },
	])("refuses a malformed owner request", (change) => {
		expect(ownerRequest.safeParse({ ...request, ...change }).success).toBe(false);
	});

	it("permits proxy and extra CA settings in the wire request", () => {
		expect(
			ownerRequest.safeParse({
				...request,
				egress: { proxy: "https://proxy.invalid", caFile: "/fixture/ca.pem" },
			}).success,
		).toBe(true);
	});
});
