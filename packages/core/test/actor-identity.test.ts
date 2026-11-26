import { describe, expect, it } from "vitest";

import {
	ACTOR_IDENTITY_PREFIX,
	actorCommandDigest,
	actorCompoundKey,
	parseActorCompoundKey,
	parseLogicalActorIdentity,
} from "../src/index.js";

const valid = {
	tenantId: "acme",
	projectId: "shop",
	actorTypeId: "Cart",
	keySegments: ["user-1"],
	schemaVersion: 1,
};

describe("logical actor identity", () => {
	it("parses and maps to a compound Rivet key", () => {
		const identity = parseLogicalActorIdentity(valid);
		expect(actorCompoundKey(identity)).toEqual([
			ACTOR_IDENTITY_PREFIX,
			"acme",
			"shop",
			"Cart",
			"user-1",
		]);
		expect(parseActorCompoundKey(actorCompoundKey(identity))).toEqual(identity);
	});

	it("rejects delimiter concatenation and empty keys", () => {
		expect(() =>
			parseLogicalActorIdentity({ ...valid, keySegments: [] }),
		).toThrow(/keySegments/);
		expect(() =>
			parseLogicalActorIdentity({ ...valid, tenantId: "acme/../x" }),
		).toThrow(/tenantId/);
		expect(() =>
			parseActorCompoundKey(["rivet", "acme", "shop", "Cart", "1"]),
		).toThrow(/hobo/);
	});

	it("rejects non-NFC unicode and oversized segments", () => {
		const nfd = "cafe\u0301";
		expect(() =>
			parseLogicalActorIdentity({ ...valid, keySegments: [nfd] }),
		).toThrow(/NFC/);
		expect(() =>
			parseLogicalActorIdentity({
				...valid,
				keySegments: ["x".repeat(200)],
			}),
		).toThrow(/bytes/);
	});

	it("digests are deterministic and payload-sensitive", () => {
		const identity = parseLogicalActorIdentity(valid);
		const a = actorCommandDigest({
			identity,
			commandType: "addItem",
			commandId: "cmd-1",
			payload: { sku: "hat", qty: 1 },
			expectedRevision: 0,
		});
		const b = actorCommandDigest({
			identity,
			commandType: "addItem",
			commandId: "cmd-1",
			payload: { qty: 1, sku: "hat" },
			expectedRevision: 0,
		});
		const c = actorCommandDigest({
			identity,
			commandType: "addItem",
			commandId: "cmd-1",
			payload: { sku: "hat", qty: 2 },
			expectedRevision: 0,
		});
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});
});
