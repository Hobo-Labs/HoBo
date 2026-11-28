import { describe, expect, it } from "vitest";
import { resolveActorPlacement } from "../src/placement.js";
import type { ActorHost } from "../src/ports.js";

function stubHost(label: string): ActorHost {
	return {
		acquire(key) {
			return {
				key,
				holderId: label,
				fenceToken: 1n,
				expiresAt: new Date().toISOString(),
				release() {},
			};
		},
		state() {
			return {
				append: () => ({ streamId: "s", seq: 1, fenceToken: 1n }),
				// SAFETY: assertion to `{} as never` is required at this boundary.
				read: () => ({ streamId: "s", seq: 0, state: {} as never }),
			};
		},
	};
}

describe("resolveActorPlacement", () => {
	const native = stubHost("native");
	const dapr = stubHost("dapr");
	const rivet = stubHost("rivet");
	const celld = stubHost("celld");

	it("defaults to native (ADR-0031)", () => {
		const r = resolveActorPlacement({ nativeHost: native });
		expect(r.mode).toBe("native");
		expect(r.source).toBe("default");
		expect(r.host).toBe(native);
	});

	it("selects dapr from camp runtime requirements", () => {
		const r = resolveActorPlacement({
			nativeHost: native,
			daprHost: dapr,
			campRuntimeRequirements: ["dapr"],
		});
		expect(r.mode).toBe("dapr");
		expect(r.host).toBe(dapr);
		expect(r.source).toBe("camp-runtime");
	});

	it("selects rivet from camp runtime requirements", () => {
		const r = resolveActorPlacement({
			nativeHost: native,
			rivetHost: rivet,
			campRuntimeRequirements: ["runtime-rivet"],
		});
		expect(r.mode).toBe("rivet");
		expect(r.host).toBe(rivet);
		expect(r.source).toBe("camp-runtime");
	});

	it("prefers rivet over dapr when both appear in requirements", () => {
		const r = resolveActorPlacement({
			nativeHost: native,
			daprHost: dapr,
			rivetHost: rivet,
			campRuntimeRequirements: ["dapr", "rivet"],
		});
		expect(r.mode).toBe("rivet");
		expect(r.host).toBe(rivet);
	});

	it("explicit native wins over camp rivet", () => {
		const r = resolveActorPlacement({
			explicit: "native",
			nativeHost: native,
			rivetHost: rivet,
			campRuntimeRequirements: ["rivet"],
		});
		expect(r.mode).toBe("native");
		expect(r.host).toBe(native);
	});

	it("selects celld from camp runtime requirements", () => {
		const r = resolveActorPlacement({
			nativeHost: native,
			celldHost: celld,
			campRuntimeRequirements: ["runtime-celld"],
		});
		expect(r.mode).toBe("celld");
		expect(r.host).toBe(celld);
	});

	it("explicit celld fails closed when host missing", () => {
		expect(() =>
			resolveActorPlacement({
				explicit: "celld",
				nativeHost: native,
			}),
		).toThrow(/celld-backed ActorHost/);
	});

	it("explicit rivet fails closed when host missing", () => {
		expect(() =>
			resolveActorPlacement({
				explicit: "rivet",
				nativeHost: native,
			}),
		).toThrow(/Rivet-backed ActorHost/);
	});

	it("fails closed when dapr required but host missing", () => {
		expect(() =>
			resolveActorPlacement({
				nativeHost: native,
				campRuntimeRequirements: ["dapr"],
			}),
		).toThrow(/Dapr ActorHost/);
	});
});
