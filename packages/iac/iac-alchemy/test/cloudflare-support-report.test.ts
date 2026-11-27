import { expect, it } from "vitest";
import { describeCloudflarePrimitiveSupport } from "../src/cloudflare.js";
import { cloudflareNativeR2BindleMappers } from "../src/cloudflare-native-r2.js";

it("retains Cloudflare support rows and reasons when Array.map is replaced", () => {
	const catalog = [
		{ factory: "web", allowVerbs: [] },
		{ factory: "topic", allowVerbs: ["publish"] },
	];
	const nativeMap = Array.prototype.map;
	let report: ReturnType<typeof describeCloudflarePrimitiveSupport> | undefined;
	try {
		Reflect.set(
			Array.prototype,
			"map",
			// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test delegates arbitrary native map callbacks unchanged.
			function (this: { kind?: string }[], predicate: unknown) {
				if (this[0]?.kind === "web") return [];
				// oxlint-disable-next-line anti-slop/no-reflect-apply -- Preserve the original callback and receiver.
				return Reflect.apply(nativeMap, this, [predicate]);
			},
		);
		report = describeCloudflarePrimitiveSupport(catalog);
	} finally {
		Reflect.set(Array.prototype, "map", nativeMap);
	}
	expect(report).toHaveLength(2);
	expect(report?.[0]).toMatchObject({ kind: "web", status: "partial" });
	expect(report?.[0]?.reason).toContain("Vite");
	expect(report?.[1]).toMatchObject({
		kind: "topic",
		status: "unsupported",
		unsupportedOperations: ["publish"],
	});
	expect(report?.[1]?.reason).toContain("multi-subscriber");
});

it("writes Cloudflare support rows as dense own data", () => {
	const catalog = [{ factory: "web", allowVerbs: [] }];
	const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
	let calls = 0;
	let report: ReturnType<typeof describeCloudflarePrimitiveSupport> | undefined;
	try {
		Object.defineProperty(Array.prototype, "0", {
			configurable: true,
			set() {
				calls++;
			},
		});
		report = describeCloudflarePrimitiveSupport(catalog);
	} finally {
		if (previous) Object.defineProperty(Array.prototype, "0", previous);
		else Reflect.deleteProperty(Array.prototype, "0");
	}
	expect(calls).toBe(0);
	expect(Object.getOwnPropertyDescriptor(report, "0")?.value.kind).toBe("web");
});

it("reports HTTP UI support without claiming render or drive", () => {
	const [row] = describeCloudflarePrimitiveSupport([
		{ factory: "ui", allowVerbs: ["render", "drive"] },
	]);
	expect(row).toMatchObject({
		status: "partial",
		resourceTypes: ["Cloudflare.Worker"],
		supportedOperations: [],
		unsupportedOperations: ["render", "drive"],
	});
	expect(row?.reason).toContain(
		"render and drive operations are not implemented",
	);
});

it("reports the selected bounded KV and R2 mappers and their limitations", () => {
	const mappers = cloudflareNativeR2BindleMappers({
		workerModules: {},
		verifyBucket: () => true,
		verifyGrant: () => true,
		kv: { verifyNamespace: () => true, verifyGrant: () => true },
	});
	const report = describeCloudflarePrimitiveSupport(
		[
			{ factory: "kv", allowVerbs: ["get", "set", "delete"] },
			{ factory: "bucket", allowVerbs: ["read", "write", "delete"] },
			{ factory: "topic", allowVerbs: ["publish", "subscribe"] },
		],
		mappers,
	);
	expect(report[0]).toMatchObject({
		status: "partial",
		supportedOperations: ["get", "set", "delete"],
		unsupportedOperations: [],
	});
	expect(report[0]?.reason).toContain("eventual visibility");
	expect(report[1]).toMatchObject({
		status: "partial",
		supportedOperations: ["read", "write", "delete"],
		unsupportedOperations: [],
	});
	expect(report[1]?.reason).toContain("blob events");
	expect(report[2]).toMatchObject({ status: "unsupported" });
	expect(report[2]?.reason).toContain("multi-subscriber");
});
