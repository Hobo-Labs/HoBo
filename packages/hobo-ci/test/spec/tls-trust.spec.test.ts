import { expect, it, vi } from "vitest";
import { snapshotDefaultTrust } from "../../src/tls-trust.js";

it("uses the effective roots when the runtime exposes them", () => {
	const read = vi.fn((source: "default" | "bundled" | "extra") => {
		if (source === "default") return ["fixture-bundled", "fixture-extra"];
		return source === "bundled" ? ["fixture-bundled"] : ["fixture-extra"];
	});
	expect(snapshotDefaultTrust(read)).toEqual([
		"fixture-bundled",
		"fixture-extra",
	]);
	expect(read).toHaveBeenCalledTimes(3);
});

it("accepts duplicate roots when all occurrences are accounted for", () => {
	const read = (source: "default" | "bundled" | "extra") =>
		source === "default" ? ["fixture-root", "fixture-root"] : ["fixture-root"];
	expect(snapshotDefaultTrust(read)).toEqual(["fixture-root", "fixture-root"]);
});

it("refuses when the runtime cannot inspect its effective trust", () => {
	expect(() => snapshotDefaultTrust(undefined)).toThrow(
		"This Node runtime cannot inspect its effective TLS trust.",
	);
});

it.each([
	["22.14.0", false],
	["22.15.0", true],
	["23.9.0", false],
	["23.10.0", true],
	["24.0.0", true],
	["24.22.2", true],
	["24.0.0-rc.1", false],
	["25.0.0", false],
	["invalid", false],
] as const)("checks the reviewed Node runtime range (%s)", (version, supported) => {
	const read = (source: "default" | "bundled" | "extra") =>
		source === "extra" ? [] : ["fixture-root"];
	if (supported)
		expect(snapshotDefaultTrust(read, version)).toEqual(["fixture-root"]);
	else
		expect(() => snapshotDefaultTrust(read, version)).toThrow(
			"This Node runtime has not been verified for effective TLS trust.",
		);
});

it.each([
	{
		effective: ["fixture-bundled"],
		bundled: ["fixture-bundled"],
		extra: ["fixture-missing-extra"],
	},
	{
		effective: ["fixture-bundled"],
		bundled: ["fixture-missing-bundled"],
		extra: [],
	},
	{ effective: ["fixture-bundled"], bundled: [], extra: [] },
	{
		effective: ["fixture-root"],
		bundled: ["fixture-root"],
		extra: ["fixture-root"],
	},
])("refuses a trust snapshot that cannot be verified", ({
	effective,
	bundled,
	extra,
}) => {
	const read = (source: "default" | "bundled" | "extra") => {
		if (source === "default") return effective;
		return source === "bundled" ? bundled : extra;
	};
	expect(() => snapshotDefaultTrust(read)).toThrow(
		"This Node runtime cannot verify its effective TLS trust.",
	);
});
