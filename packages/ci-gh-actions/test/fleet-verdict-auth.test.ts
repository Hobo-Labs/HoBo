import { meshIdentityFromPem } from "@hobo/ci/mesh";
import { describe, expect, it } from "vitest";
import {
	FLEET_VERDICT_SIGNING_CONTEXT,
	type FleetVerdictSigningFields,
	fleetVerdictSigningInput,
	signedFleetVerdictRequest,
	signFleetVerdictReport,
	verifyFleetVerdictReport,
} from "../src/fleet-verdict-auth.js";
import {
	BOX_1_KEY_PEM,
	BOX_1_PUBLIC_KEY,
	BOX_2_PUBLIC_KEY,
} from "./fixtures/fleet-reporter-keys.js";

/**
 * The reporter on the box and the hosted relay agree on a report's signature
 * only through `fleetVerdictSigningInput`; these three vectors fix it. A
 * change that breaks one breaks every enrolled reporter: it needs a new
 * context string.
 */
const VECTOR_KEY_PEM = BOX_1_KEY_PEM;
const VECTOR_PUBLIC_KEY = BOX_1_PUBLIC_KEY;
const OTHER_PUBLIC_KEY = BOX_2_PUBLIC_KEY;

const VECTORS: readonly Readonly<{
	name: string;
	fields: FleetVerdictSigningFields;
	input: string;
	signature: string;
}>[] = [
	{
		name: "a report that blocks a label",
		fields: {
			origin: "https://hobo-ci.vercel.app",
			path: "/v1/fleet/verdicts/hobo-labs/hobo",
			body: '{"blocked":{"hobo":{"reason":"no-capacity"}},"ttlSeconds":180,"mode":"report"}',
			issuedAt: "2026-11-12T16:00:05.000Z",
			sequence: "1794499205000",
		},
		input:
			"hobo-fleet-verdict-v1\nPUT\nhttps://hobo-ci.vercel.app\n/v1/fleet/verdicts/hobo-labs/hobo\n2f17a30ee50ad33bc5e665ea9d873f90c0b6f9a29ef4668c1be18917fe0b97db\n2026-11-12T16:00:05.000Z\n1794499205000",
		signature:
			"ed25519=77ohGuisWU51-pmwpPtTC97eZkI7O8nXS35HsTE2maBCrn4JYxcuuHYbuYsVXH77NO2W1QjeVBNx69frpT_oAA",
	},
	{
		name: "a shadow report, its origin and path in mixed case with a trailing slash",
		fields: {
			origin: "HTTPS://Hobo-CI.vercel.app/",
			path: "/v1/fleet/verdicts/Hobo-Labs/HoBo",
			body: '{"ttlSeconds":180,"mode":"shadow"}',
			issuedAt: "2026-11-12T16:01:05.123Z",
			sequence: "1794499265123",
		},
		input:
			"hobo-fleet-verdict-v1\nPUT\nhttps://hobo-ci.vercel.app\n/v1/fleet/verdicts/hobo-labs/hobo\n92fc31750e49f1df67046375ddc6f157e4ffa6a751996e2cda9a190bfb7669d3\n2026-11-12T16:01:05.123Z\n1794499265123",
		signature:
			"ed25519=4H-lQNYGdzBLSTg-P0zrCZjHGPUAI6RnP7QYzy6c0XyN_x_40iPU7VkbM5y4lIUsaJeK7Psu8XaxMHx-7tZVDA",
	},
	{
		name: "an empty body at another relay, the smallest sequence",
		fields: {
			origin: "https://ci.hobo.test",
			path: "/v1/fleet/verdicts/acme/app.v2",
			body: "",
			issuedAt: "2026-01-01T00:00:00.000Z",
			sequence: "1",
		},
		input:
			"hobo-fleet-verdict-v1\nPUT\nhttps://ci.hobo.test\n/v1/fleet/verdicts/acme/app.v2\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n2026-01-01T00:00:00.000Z\n1",
		signature:
			"ed25519=CrvwzxN_nenEfIfz-YwaaQADvqgJ9F4vPu1g1I6pgunEL8Cnv2wXbC3laUkItzgR0BwoMnONKq1QMXx2f7ljAw",
	},
];

describe("the fleet verdict signing input", () => {
	const identity = meshIdentityFromPem(VECTOR_KEY_PEM);

	it("is signed by the vector key", () => {
		expect(identity.publicKey).toBe(VECTOR_PUBLIC_KEY);
	});

	for (const vector of VECTORS)
		it(`is fixed for ${vector.name}`, () => {
			expect(fleetVerdictSigningInput(vector.fields)).toBe(vector.input);
			expect(vector.input.split("\n")).toHaveLength(7);
			expect(
				vector.input.startsWith(`${FLEET_VERDICT_SIGNING_CONTEXT}\n`),
			).toBe(true);
			expect(signFleetVerdictReport(identity, vector.fields)).toBe(
				vector.signature,
			);
			expect(
				verifyFleetVerdictReport(
					VECTOR_PUBLIC_KEY,
					vector.fields,
					vector.signature,
				),
			).toBe(true);
		});

	it("hashes the body's bytes, whether given as text or bytes", () => {
		const [first] = VECTORS;
		if (!first) throw new Error("no vector");
		expect(
			fleetVerdictSigningInput({
				...first.fields,
				body: new TextEncoder().encode(String(first.fields.body)),
			}),
		).toBe(first.input);
	});

	it("refuses an issued-at or a sequence a report may not carry", () => {
		const [first] = VECTORS;
		if (!first) throw new Error("no vector");
		for (const change of [
			{ issuedAt: "2026-11-12T16:00:05Z" },
			{ issuedAt: "2026-11-12T16:00:05.000+00:00" },
			{ issuedAt: "2026-13-12T16:00:05.000Z" },
			{ sequence: "0" },
			{ sequence: "01" },
			{ sequence: "-1" },
			{ sequence: "1.5" },
			{ sequence: "18446744073709551616" },
		])
			expect(() =>
				fleetVerdictSigningInput({ ...first.fields, ...change }),
			).toThrow();
	});
});

describe("a report's signature", () => {
	const identity = meshIdentityFromPem(VECTOR_KEY_PEM);
	const [first] = VECTORS;
	if (!first) throw new Error("no vector");

	it("fails for any other origin, path, body, time or sequence", () => {
		for (const change of [
			{ origin: "https://hobo-ci-preview.vercel.app" },
			{ path: "/v1/fleet/verdicts/hobo-labs/other" },
			{ body: '{"ttlSeconds":180,"mode":"report"}' },
			{ issuedAt: "2026-11-12T16:00:06.000Z" },
			{ sequence: "1794499205001" },
		])
			expect(
				verifyFleetVerdictReport(
					VECTOR_PUBLIC_KEY,
					{ ...first.fields, ...change },
					first.signature,
				),
			).toBe(false);
	});

	it("fails for another key, and for anything that is not a signature", () => {
		expect(
			verifyFleetVerdictReport(OTHER_PUBLIC_KEY, first.fields, first.signature),
		).toBe(false);
		for (const signature of [
			"",
			first.signature.slice(8),
			`rsa=${first.signature.slice(8)}`,
			`${first.signature}A`,
			"ed25519=",
		])
			expect(
				verifyFleetVerdictReport(VECTOR_PUBLIC_KEY, first.fields, signature),
			).toBe(false);
		expect(
			verifyFleetVerdictReport("not-a-key", first.fields, first.signature),
		).toBe(false);
	});

	it("is sent as a request whose headers and path verify at the relay", () => {
		const request = signedFleetVerdictRequest({
			identity,
			reporterId: "box-1",
			origin: "https://hobo-ci.vercel.app/",
			repository: "Hobo-Labs/HoBo",
			body: String(first.fields.body),
			issuedAt: first.fields.issuedAt,
			sequence: first.fields.sequence,
		});
		expect(request).toEqual({
			url: "https://hobo-ci.vercel.app/v1/fleet/verdicts/hobo-labs/hobo",
			path: "/v1/fleet/verdicts/hobo-labs/hobo",
			headers: {
				"Content-Type": "application/json",
				"X-HoBo-Reporter": "box-1",
				"X-HoBo-Sequence": "1794499205000",
				"X-HoBo-Issued-At": "2026-11-12T16:00:05.000Z",
				"X-HoBo-Signature": first.signature,
			},
			body: first.fields.body,
		});
		expect(() =>
			signedFleetVerdictRequest({
				identity,
				reporterId: "box 1",
				origin: "https://hobo-ci.vercel.app",
				repository: "hobo-labs/hobo",
				body: "",
				issuedAt: first.fields.issuedAt,
				sequence: "1",
			}),
		).toThrow();
	});
});
