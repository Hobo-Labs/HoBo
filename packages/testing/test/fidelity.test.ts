import { describe, expect, it } from "vitest";
import {
	CAMP_ONLY_KINDS,
	emptyFidelityCounts,
	FIDELITIES,
	HTTP_SERVED_KINDS,
	inProcessFidelity,
	isHttpServedKind,
} from "../src/index.js";

describe("ADR-0042 fidelity vocabulary", () => {
	it("is exactly the four labels, frozen", () => {
		expect([...FIDELITIES]).toEqual([
			"real",
			"simulated",
			"mocked",
			"camp-only",
		]);
		expect(Object.isFrozen(FIDELITIES)).toBe(true);
		expect(Object.isFrozen(CAMP_ONLY_KINDS)).toBe(true);
		expect(Object.isFrozen(HTTP_SERVED_KINDS)).toBe(true);
	});

	it("starts every count at zero", () => {
		expect(emptyFidelityCounts()).toEqual({
			real: 0,
			simulated: 0,
			mocked: 0,
			"camp-only": 0,
		});
	});
});

describe("inProcessFidelity", () => {
	it.each([
		["api", true, "simulated"],
		["web", true, "simulated"],
		["service", true, "simulated"],
		["ui", true, "simulated"],
		["api", false, "mocked"],
		["data", false, "mocked"],
		["kv", true, "mocked"],
		["secret", false, "mocked"],
		["container", true, "camp-only"],
		["wasm-component", false, "camp-only"],
	])("labels kind %s (served=%s) as %s", (kind, served, expected) => {
		expect(inProcessFidelity(kind as string, served as boolean)).toBe(expected);
	});

	it("never labels anything real — this lane runs no deployed artifact", () => {
		const kinds = [
			"api",
			"web",
			"service",
			"ui",
			"data",
			"kv",
			"bucket",
			"queue",
			"topic",
			"secret",
			"auth",
			"crypto",
			"container",
			"wasm-component",
			"unheard-of-kind",
		];
		for (const kind of kinds) {
			for (const served of [true, false]) {
				expect(inProcessFidelity(kind, served)).not.toBe("real");
			}
		}
	});

	it("treats an unknown kind as mocked rather than optimistically simulated", () => {
		expect(inProcessFidelity("unheard-of-kind", true)).toBe("mocked");
		expect(isHttpServedKind("unheard-of-kind")).toBe(false);
	});
});
