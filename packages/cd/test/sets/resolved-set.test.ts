import { describe, expect, it } from "vitest";
import { ChangeKind } from "../../src/_generated/cd_pb.js";
import {
	DesiredStateError,
	decodeResolvedSetBlob,
	diffResolvedSets,
	encodeResolvedSetBlob,
	verifyResolvedSet,
} from "../../src/sets/index.js";
import { resolvedFor, SHOP_V1, SHOP_V2 } from "./fakes.js";

function refusalCode(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		if (error instanceof DesiredStateError) return error.code;
		throw error;
	}
	return undefined;
}

describe("resolved-set blob codec", () => {
	it("encodes canonically: key order never changes the bytes or digest (HOBO-50)", () => {
		const resolved = resolvedFor("prod-aws", SHOP_V1);
		const reordered = Object.fromEntries(Object.entries(resolved).reverse()) as typeof resolved;
		const a = encodeResolvedSetBlob(resolved);
		const b = encodeResolvedSetBlob(reordered);
		expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
		expect(a.digest).toBe(b.digest);
		expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(a.bytes.byteLength).toBe(a.size);
	});

	it("round-trips: decode(encode(x)) verifies and equals x", () => {
		const resolved = resolvedFor("prod-aws", SHOP_V1);
		const blob = encodeResolvedSetBlob(resolved);
		const decoded = decodeResolvedSetBlob(blob.bytes, { digest: blob.digest, size: blob.size });
		expect(decoded.contentHash).toBe(verifyResolvedSet(resolved).contentHash);
		expect(decoded.contentHash).toBe(blob.resolved.contentHash);
		expect(decoded).toEqual(blob.resolved);
		expect(decoded.plan.resources.map((r) => r.name)).toEqual(["shop.api", "shop.cache", "shop.db"]);
	});

	it("refuses bytes whose digest does not match (corruption at rest)", () => {
		const blob = encodeResolvedSetBlob(resolvedFor("prod-aws", SHOP_V1));
		const tampered = new Uint8Array(blob.bytes);
		tampered[10] = (tampered[10] ?? 0) ^ 1;
		expect(refusalCode(() => decodeResolvedSetBlob(tampered, { digest: blob.digest, size: blob.size }))).toBe(
			"resolved-set-digest-mismatch",
		);
	});

	it("content identity is independent of object key order", () => {
		const resolved = resolvedFor("prod-aws", SHOP_V1);
		// Reverse the keys of every object that is not an array member (the
		// producer hash in @hobo/cloud sorts object keys, not array members').
		const reordered = JSON.parse(
			JSON.stringify(resolved, function (this: unknown, _key: string, value: unknown) {
				if (value && typeof value === "object" && !Array.isArray(value) && !Array.isArray(this)) {
					return Object.fromEntries(Object.entries(value).reverse());
				}
				return value;
			}),
		);
		expect(Object.keys(reordered)[0]).toBe("contentHash");
		expect(encodeResolvedSetBlob(reordered).digest).toBe(encodeResolvedSetBlob(resolved).digest);
		expect(verifyResolvedSet(reordered).contentHash).toBe(verifyResolvedSet(resolved).contentHash);
	});

	it("refuses a resolved set whose content hash was forged", () => {
		const resolved = resolvedFor("prod-aws", SHOP_V1);
		const forged = { ...resolved, environment: "staging" };
		expect(refusalCode(() => verifyResolvedSet(forged))).toBe("resolved-set-invalid");
	});

	it("fails closed when a resource depends on one absent from the Set (delta-set-apply-reconcile)", () => {
		const broken = resolvedFor("prod-aws", [{ name: "shop.api", deps: ["shop.db"] }]);
		expect(refusalCode(() => verifyResolvedSet(broken))).toBe("missing-dependency");
	});

	it("refuses plaintext secret material (I9)", () => {
		const leaky = resolvedFor("prod-aws", [{ name: "shop.api", image: "ghp_abcdefghijklmnopqrstuvwxyz0123" }]);
		expect(refusalCode(() => verifyResolvedSet(leaky))).toBe("secret-material");
	});
});

describe("diffResolvedSets (HOBO-50 add/update/remove)", () => {
	it("computes add/update/remove changes between two Sets in resource order", () => {
		const before = resolvedFor("prod-aws", SHOP_V1);
		const after = resolvedFor("prod-aws", SHOP_V2);
		const changes = diffResolvedSets(before, after);
		expect(changes.map((c) => `${ChangeKind[c.kind]}:${c.resource}`)).toEqual([
			"UPDATE:shop.api",
			"REMOVE:shop.cache",
			"ADD:shop.worker",
		]);
		const update = changes[0];
		expect(update?.beforeHash).toMatch(/^sha256:/);
		expect(update?.afterHash).not.toBe(update?.beforeHash);
		expect(changes[1]?.afterHash).toBe("");
		expect(changes[2]?.beforeHash).toBe("");
	});

	it("an unchanged resource emits no change; identical Sets diff to nothing", () => {
		const before = resolvedFor("prod-aws", SHOP_V1);
		expect(diffResolvedSets(before, resolvedFor("prod-aws", SHOP_V1))).toEqual([]);
		expect(diffResolvedSets(before, resolvedFor("prod-aws", SHOP_V2)).some((c) => c.resource === "shop.db")).toBe(
			false,
		);
	});

	it("diffs from nothing as all adds", () => {
		const changes = diffResolvedSets(undefined, resolvedFor("prod-aws", SHOP_V1));
		expect(changes.every((c) => c.kind === ChangeKind.ADD)).toBe(true);
		expect(changes).toHaveLength(3);
	});
});
