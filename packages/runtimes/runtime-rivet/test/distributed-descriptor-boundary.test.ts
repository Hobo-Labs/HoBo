import { describe, expect, it } from "vitest";
import { computeRivetOperationDigest } from "../src/distributed-auth.js";
import { snapshotDistributedData } from "../src/distributed-journal.js";

describe("Rivet journal value boundaries", () => {
	it("rejects sparse arrays even when a descriptor is inherited", () => {
		const sparse: unknown[] = [];
		sparse.length = 1;
		let result: unknown;
		try {
			Object.defineProperty(Object.prototype, "0", {
				configurable: true,
				writable: true,
				value: { value: "forged" },
			});
			result = snapshotDistributedData(sparse);
		} finally {
			Reflect.deleteProperty(Object.prototype, "0");
		}
		expect(result).toBeUndefined();
	});

	it("does not inspect accessor values inherited by a descriptor", () => {
		let reads = 0;
		const value = {
			get item() {
				reads++;
				return "unexpected";
			},
		};
		let result: unknown;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					reads++;
					return "forged";
				},
			});
			result = snapshotDistributedData(value);
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
		}
		expect(result).toBeUndefined();
		expect(reads).toBe(0);
	});

	it("refuses proxy data before invoking its traps", () => {
		let traps = 0;
		const value = new Proxy({ item: "value" }, {
			ownKeys(target) {
				traps++;
				return Reflect.ownKeys(target);
			},
		});
		expect(snapshotDistributedData(value)).toBeUndefined();
		expect(() =>
			computeRivetOperationDigest({
				actorKey: ["hobo", "tenant", "camp", "actor"],
				action: "acquire",
				args: value,
			}),
		).toThrow();
		expect(traps).toBe(0);
	});
});
