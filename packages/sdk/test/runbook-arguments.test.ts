import type { JsonValue } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { runbook } from "../src/runbook.js";

describe("runbook effect argument wire boundary", () => {
	it("preserves nested JSON evidence and independently freezes the parsed argument tree", () => {
		const nested = {
			replicas: 2,
			zones: ["one", "two"],
			enabled: true,
			reason: null,
		};
		const authored = runbook("scale", {
			on: { alert: "load" },
			diagnose: ["inspect"],
			fix: [{ when: "overload", do: "scale", nested }],
		});
		expect(authored.fix[0]?.args.nested).toEqual(nested);
		expect(Object.isFrozen(authored.fix[0]?.args.nested)).toBe(true);
		expect(Object.isFrozen(nested)).toBe(false);
	});
	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("rejects a non-JSON numeric argument %s", (amount) => {
		expect(() =>
			runbook("scale", {
				on: { alert: "load" },
				diagnose: ["inspect"],
				fix: [{ when: "overload", do: "scale", amount }],
			}),
		).toThrow(/JSON values/);
	});
	it("rejects cyclic arguments before freezing or executing them", () => {
		const cycle: Record<string, JsonValue> = {};
		cycle.self = cycle;
		expect(() =>
			runbook("scale", {
				on: { alert: "load" },
				diagnose: ["inspect"],
				fix: [{ when: "overload", do: "scale", cycle }],
			}),
		).toThrow(/acyclic JSON/);
	});
	it("rejects sparse array holes instead of silently converting them into JSON nulls", () => {
		const sparse: JsonValue[] = [];
		sparse.length = 1;
		expect(() =>
			runbook("scale", {
				on: { alert: "load" },
				diagnose: ["inspect"],
				fix: [{ when: "overload", do: "scale", zones: sparse }],
			}),
		).toThrow(/JSON values/);
	});
});
