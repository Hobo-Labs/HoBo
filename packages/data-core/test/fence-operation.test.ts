import { describe, expect, it } from "vitest";
import {
	canonicalFenceOperationReceipt,
	fenceTokenDigest,
} from "../src/index.js";

const body = {
	contract: "hobo.fence-operation-receipt/v1" as const,
	scope: { dataset: "orders", tenant: "tenant-1" },
	operationId: "handover-1",
	routeDigest: `sha256:${"a".repeat(64)}`,
	receiverKeyId: "route-receiver-1",
	fenceTokenDigest: fenceTokenDigest("source-token"),
	outcome: "committed" as const,
};

describe("native fence receipt contract", () => {
	it("encodes the exact route and source fence in deterministic canonical JSON", () => {
		const encoded = canonicalFenceOperationReceipt(body);
		expect(JSON.parse(encoded)).toEqual(body);
		expect(
			canonicalFenceOperationReceipt({
				...body,
				scope: { tenant: "tenant-1", dataset: "orders" },
			}),
		).toBe(encoded);
		expect(encoded).not.toContain("source-token");
	});

	it("rejects invalid fields and any unsigned extension", () => {
		expect(() =>
			canonicalFenceOperationReceipt({ ...body, routeDigest: "sha256:bad" }),
		).toThrow();
		expect(() =>
			canonicalFenceOperationReceipt({
				...body,
				operationId: "bad\noperation",
			}),
		).toThrow();
		expect(() =>
			canonicalFenceOperationReceipt({
				...body,
				scope: { ...body.scope, tenant: " " },
			}),
		).toThrow();
		const extended = { ...body, unsignedField: true };
		expect(() => canonicalFenceOperationReceipt(extended)).toThrow();
		const extendedScope = {
			...body,
			scope: { ...body.scope, extra: "ignored" },
		};
		expect(() => canonicalFenceOperationReceipt(extendedScope)).toThrow();
	});

	it("rejects every trailing line terminator on either digest", () => {
		for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
			expect(() =>
				canonicalFenceOperationReceipt({
					...body,
					routeDigest: body.routeDigest + suffix,
				}),
			).toThrow();
			expect(() =>
				canonicalFenceOperationReceipt({
					...body,
					fenceTokenDigest: body.fenceTokenDigest + suffix,
				}),
			).toThrow();
		}
	});
});
