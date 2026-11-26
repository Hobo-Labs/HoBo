/**
 * The component-host manifest parser.
 *
 * This is the gate between a manifest file and every conformance claim made
 * from it. Its job is not to be permissive: a certified-host pin missing its
 * kind or version describes a host nobody can identify, and a suite that ran
 * against an unidentifiable host has certified nothing.
 *
 * Two properties beyond the refusals are worth pinning. The parser returns a
 * **frozen deep clone**, not the caller's object — a manifest the caller can
 * still mutate after parsing would let the bytes that were checked and the
 * bytes that are used diverge, silently, with the check already passed. And
 * an empty `certifiedHosts` array is refused rather than treated as "no hosts
 * to check", because a suite with nothing to run reports success.
 */

import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/json.js";

import { parseComponentHostManifest } from "../src/suites/component-host/index.js";

const manifest = (overrides: JsonObject = {}) => ({
	componentHost: {
		certifiedHosts: [{ kind: "wasmtime", version: "26.0.0" }],
		...overrides,
	},
});

describe("parseComponentHostManifest", () => {
	it("accepts a minimal manifest", () => {
		expect(parseComponentHostManifest(manifest())).toMatchObject({
			componentHost: { certifiedHosts: [{ kind: "wasmtime" }] },
		});
	});

	it("accepts several certified hosts", () => {
		// SAFETY: assertion to `rseComponentHostManifest( manifest({ certifiedHosts: [ { kind: "wasmtime", version: "26.0.0" }, { kind: "jco", version: ` is required at this boundary.
		const parsed = parseComponentHostManifest(
			manifest({
				certifiedHosts: [
					{ kind: "wasmtime", version: "26.0.0" },
					{ kind: "jco", version: "1.4.0" },
				],
			}),
		) as { componentHost: { certifiedHosts: JsonValue[] } };
		expect(parsed.componentHost.certifiedHosts).toHaveLength(2);
	});

	it("keeps fields it does not itself inspect", () => {
		// The parser checks a floor, not a schema; dropping unknown keys would
		// silently discard whatever the suite actually reads.
		// SAFETY: assertion to `rseComponentHostManifest({ ...manifest(), extra: { note: "kept" }, }) as JsonObject; ` is required at this boundary.
		const parsed = parseComponentHostManifest({
			...manifest(),
			extra: { note: "kept" },
		}) as JsonObject;
		expect(parsed.extra).toEqual({ note: "kept" });
	});

	it.each([
		null,
		undefined,
		7,
		"manifest",
		true,
	])("refuses the non-object manifest %s", (raw) => {
		expect(() => parseComponentHostManifest(raw)).toThrow(TypeError);
	});

	it("refuses an array, which is an object but not a manifest", () => {
		// `isJsonObject([])`, so the array case has to be excluded by hand
		// or a list of hosts would parse as a manifest with no host section.
		expect(() => parseComponentHostManifest([])).toThrow(
			/manifest must be an object/u,
		);
	});

	it("refuses a manifest with no componentHost section", () => {
		expect(() => parseComponentHostManifest({})).toThrow(
			/componentHost is required/u,
		);
	});

	it.each([
		null,
		7,
		"hosts",
		[],
	])("refuses the non-object componentHost %s", (componentHost) => {
		expect(() => parseComponentHostManifest({ componentHost })).toThrow(
			/componentHost is required/u,
		);
	});

	it("refuses a missing certifiedHosts list", () => {
		expect(() => parseComponentHostManifest({ componentHost: {} })).toThrow(
			/certifiedHosts must be a non-empty array/u,
		);
	});

	it("refuses an empty certifiedHosts list", () => {
		// A suite with nothing to run reports success, which is the worst
		// possible answer from a conformance check.
		expect(() =>
			parseComponentHostManifest(manifest({ certifiedHosts: [] })),
		).toThrow(/non-empty array/u);
	});

	it("refuses a certifiedHosts value that is not a list", () => {
		expect(() =>
			parseComponentHostManifest(manifest({ certifiedHosts: "wasmtime" })),
		).toThrow(/non-empty array/u);
	});

	it.each([null, 7, "wasmtime"])("refuses the non-object pin %s", (pin) => {
		expect(() =>
			parseComponentHostManifest(manifest({ certifiedHosts: [pin] })),
		).toThrow(/certified host pin must be an object/u);
	});

	it("refuses a pin with no kind", () => {
		// A pin without a kind names no host, so nothing can be checked against
		// it.
		expect(() =>
			parseComponentHostManifest(
				manifest({ certifiedHosts: [{ version: "26.0.0" }] }),
			),
		).toThrow(/host\.kind must be non-empty/u);
	});

	it("refuses an empty kind", () => {
		expect(() =>
			parseComponentHostManifest(
				manifest({ certifiedHosts: [{ kind: "", version: "26.0.0" }] }),
			),
		).toThrow(/host\.kind must be non-empty/u);
	});

	it("refuses a non-string kind", () => {
		expect(() =>
			parseComponentHostManifest(
				manifest({ certifiedHosts: [{ kind: 7, version: "26.0.0" }] }),
			),
		).toThrow(/host\.kind must be non-empty/u);
	});

	it("refuses a pin with no version", () => {
		// "wasmtime" without a version certifies every wasmtime that ever
		// shipped, including the ones with the bug.
		expect(() =>
			parseComponentHostManifest(
				manifest({ certifiedHosts: [{ kind: "wasmtime" }] }),
			),
		).toThrow(/host\.version must be non-empty/u);
	});

	it("refuses an empty version", () => {
		expect(() =>
			parseComponentHostManifest(
				manifest({ certifiedHosts: [{ kind: "wasmtime", version: "" }] }),
			),
		).toThrow(/host\.version must be non-empty/u);
	});

	it("checks every pin, not just the first", () => {
		// A valid pin first would otherwise mask an invalid one behind it.
		expect(() =>
			parseComponentHostManifest(
				manifest({
					certifiedHosts: [
						{ kind: "wasmtime", version: "26.0.0" },
						{ kind: "jco" },
					],
				}),
			),
		).toThrow(/host\.version must be non-empty/u);
	});

	it("freezes what it returns", () => {
		expect(Object.isFrozen(parseComponentHostManifest(manifest()))).toBe(true);
	});

	it("returns a clone, not the caller's object", () => {
		// If the caller kept a handle on the parsed manifest, the bytes that were
		// checked and the bytes that are used could diverge after the check
		// passed.
		const raw = manifest();
		expect(parseComponentHostManifest(raw)).not.toBe(raw);
	});

	it("is unaffected by a later mutation of the caller's manifest", () => {
		const raw = manifest();
		// SAFETY: assertion to `rseComponentHostManifest(raw) as { componentHost: { certifiedHosts: { kind: string }[] }; }; ` is required at this boundary.
		const parsed = parseComponentHostManifest(raw) as {
			componentHost: { certifiedHosts: { kind: string }[] };
		};
		raw.componentHost.certifiedHosts[0] = { kind: "evil", version: "0" };
		expect(parsed.componentHost.certifiedHosts[0]?.kind).toBe("wasmtime");
	});
});
