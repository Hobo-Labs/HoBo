/**
 * Parsing anonymous-deploy output, the equivalence classes, and the typed
 * option blocks (ADR-0127 / ADR-0156).
 *
 * `parseLakebedDeployOutput` reads the stdout of a CLI this package does not
 * control and turns it into two URLs a user will be sent to: the station they
 * were just given, and the claim link that transfers ownership of it. That
 * makes the host checks the important part. If an attacker could get an
 * arbitrary URL into that output — a poisoned npx package, a compromised
 * registry mirror, a proxy injecting a line — the claim link is a credential
 * hand-off, and pointing it at an attacker's host is the whole attack. So both
 * URLs are re-checked for `https:` and for a specific host, and the parser
 * fails closed when neither shape is present.
 *
 * The equivalence classes are the other half of this package's honesty claim:
 * feature lists are deliberately narrow so a `require` miss surfaces as a
 * partial verdict with remediation rather than as fabricated parity with a
 * closed PaaS that cannot actually offer container or postgres semantics.
 */
import { describe, expect, it } from "vitest";

import {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	lakebedNativeFeaturesForPort,
	lakebedNativePorts,
} from "../src/equivalence.js";
import { LAKEBED_PROVIDER_TARGET, lakebed } from "../src/options.js";
import { parseLakebedDeployOutput } from "../src/temporary-station.js";

const STATION = "https://abc123.lakebed.app";
const CLAIM = "https://lakebed.dev/claim/abc123";

const EXPIRES = "2030-01-01T00:00:00.000Z";
const deployed = {
	url: STATION,
	deployId: "abc123",
	claimUrl: CLAIM,
	expiresAt: EXPIRES,
};

describe("parseLakebedDeployOutput", () => {
	it("reads current pretty JSON and preserves the native expiry", () => {
		expect(
			parseLakebedDeployOutput(
				JSON.stringify(
					{ api: "https://api.lakebed.dev", ...deployed },
					null,
					2,
				),
			),
		).toEqual({
			deployId: "abc123",
			stationUrl: STATION,
			claimUrl: CLAIM,
			expiresAt: EXPIRES,
		});
	});
	it("reads a complete JSON line among progress and incomplete records", () => {
		expect(
			parseLakebedDeployOutput(
				`installing…\n{"phase":"build"}\n${JSON.stringify(deployed)}\ndone`,
			).stationUrl,
		).toBe(STATION);
	});
	it("supports explicit historical URL and id field names", () => {
		for (const urlField of ["url", "deployUrl", "primaryUrl"])
			for (const idField of ["deployId", "id"]) {
				expect(
					parseLakebedDeployOutput(
						JSON.stringify({
							[urlField]: STATION,
							[idField]: "abc123",
							claimUrl: CLAIM,
							expiresAt: EXPIRES,
						}),
					).deployId,
				).toBe("abc123");
			}
	});
	it("refuses to fabricate a claim URL or resource identity from a hostname", () => {
		for (const value of [
			{ url: STATION, deployId: "abc123" },
			{ url: STATION, claimUrl: CLAIM },
		])
			expect(() => parseLakebedDeployOutput(JSON.stringify(value))).toThrow(
				"provider-issued claim URL",
			);
		expect(() => parseLakebedDeployOutput(`Deployed: ${STATION}`)).toThrow(
			"provider-issued claim URL",
		);
	});
	it("refuses a claim for a different deployment", () => {
		expect(() =>
			parseLakebedDeployOutput(
				JSON.stringify({
					...deployed,
					claimUrl: "https://lakebed.dev/claim/other",
				}),
			),
		).toThrow("another deployment");
	});
	it("refuses missing and malformed native expiry", () => {
		for (const expiresAt of [undefined, "not-a-date"])
			expect(() =>
				parseLakebedDeployOutput(JSON.stringify({ ...deployed, expiresAt })),
			).toThrow("provider-reported expiry");
	});
	it("refuses untrusted, credential-bearing and plaintext station URLs", () => {
		for (const url of [
			"https://evil.com",
			"https://lakebed.app.evil.com",
			"https://notlakebed.app",
			"https://user:password@abc123.lakebed.app",
			"https://abc123.lakebed.app:444",
			"http://abc123.lakebed.app",
			"https://abc123.lakebed.app/?token=inline",
		])
			expect(() =>
				parseLakebedDeployOutput(JSON.stringify({ ...deployed, url })),
			).toThrow();
	});
	it("refuses untrusted and plaintext claims while admitting the current API host", () => {
		for (const claimUrl of [
			"https://evil.com/claim/abc123",
			"http://lakebed.dev/claim/abc123",
			"https://user:password@lakebed.dev/claim/abc123",
		])
			expect(() =>
				parseLakebedDeployOutput(JSON.stringify({ ...deployed, claimUrl })),
			).toThrow();
		expect(
			parseLakebedDeployOutput(
				JSON.stringify({
					...deployed,
					claimUrl: "https://api.lakebed.dev/claim/abc123/issued-token",
				}),
			).claimUrl,
		).toContain("api.lakebed.dev");
	});
	it("refuses empty or incomplete output", () => {
		for (const text of ["", "  ", "not a result", '{"url":"https://'])
			expect(() => parseLakebedDeployOutput(text)).toThrow();
	});
});

describe("equivalence classes", () => {
	it("declares one class per initial capability port", () => {
		expect([...INITIAL_CAPABILITY_PORTS].sort()).toEqual(
			Object.keys(EQUIVALENCE_CLASSES).sort(),
		);
	});

	it("maps each class to a port, a resource class and a provider service", () => {
		// The provider service name is what a portability report cites. A class
		// without one would report a match against an unnamed thing.
		for (const key of INITIAL_CAPABILITY_PORTS) {
			const entry = equivalenceForPort(key);
			expect(entry.port.length).toBeGreaterThan(0);
			expect(entry.resourceClass.startsWith("lakebed:")).toBe(true);
			expect(entry.providerService.length).toBeGreaterThan(0);
			expect(entry.features.length).toBeGreaterThan(0);
		}
	});

	it("keeps the compute feature list narrow and honest", () => {
		// Deliberately narrow: a closed Capsule runtime cannot claim container
		// semantics, so a `require: ["container"]` must surface as a partial
		// verdict with remediation rather than as fabricated parity.
		const compute = equivalenceForPort("web/service");
		expect(compute.features).toContain("capsule");
		expect(compute.features).not.toContain("container");
		expect(compute.features).not.toContain("vm");
	});

	it("keeps the database feature list off relational semantics", () => {
		const database = equivalenceForPort("database/reactive");
		expect(database.features).toContain("reactive");
		expect(database.features).not.toContain("postgres");
		expect(database.features).not.toContain("sql");
	});

	it("deduplicates the native port list", () => {
		// Two classes can share a port; a duplicated entry would make Matching
		// consider the same provider twice for one request.
		const ports = lakebedNativePorts();
		expect(new Set(ports).size).toBe(ports.length);
		expect([...ports].sort()).toEqual([
			"compute",
			"database",
			"kv",
			"objectStore",
		]);
	});

	it("returns the features for a known port", () => {
		expect(lakebedNativeFeaturesForPort("kv")).toContain("key-value");
		expect(lakebedNativeFeaturesForPort("compute")).toContain("http");
	});

	it("returns an empty list for a port it does not host", () => {
		// Empty, not undefined: a caller intersecting feature lists must not have
		// to special-case an unknown port, and an unhosted port genuinely offers
		// nothing rather than offering an unknown amount.
		expect(lakebedNativeFeaturesForPort("queue")).toEqual([]);
		expect(lakebedNativeFeaturesForPort("")).toEqual([]);
	});

	it("freezes the class table and the port list", () => {
		// These are read on every Matching pass. A caller that could add a class
		// at runtime would widen what this provider claims for the whole process.
		expect(Object.isFrozen(EQUIVALENCE_CLASSES)).toBe(true);
		expect(Object.isFrozen(INITIAL_CAPABILITY_PORTS)).toBe(true);
	});
});

describe("typed option blocks", () => {
	it("tags every block with the provider target and its port", () => {
		// The target is what makes a block inert for other providers — the core
		// promise that one Bindle targets many clouds unedited. A block missing
		// it would be applied everywhere.
		for (const [name, block] of [
			["capsule", lakebed.with.capsule()],
			["reactiveDb", lakebed.with.reactiveDb()],
			["files", lakebed.with.files()],
		] as const) {
			expect(block.providerId).toBe(LAKEBED_PROVIDER_TARGET);
			expect(block.optionName).toBe(name);
			expect(block.port.length).toBeGreaterThan(0);
		}
	});

	it("negotiates as prefer, never require", () => {
		// `prefer` is what keeps a provider-specific annotation additive: on a
		// provider that cannot honour it the deploy degrades rather than failing,
		// which is the whole point of an inert annotation.
		expect(lakebed.with.capsule().negotiation).toBe("prefer");
		expect(lakebed.with.reactiveDb().negotiation).toBe("prefer");
		expect(lakebed.with.files().negotiation).toBe("prefer");
	});

	it("applies each block's defaults", () => {
		expect(lakebed.with.capsule().options).toMatchObject({
			syncRpc: true,
			coldStart: "instant",
		});
		expect(lakebed.with.reactiveDb().options).toMatchObject({
			consistency: "reactive",
			schema: "document",
		});
		expect(lakebed.with.files().options).toMatchObject({
			publicAccess: false,
		});
	});

	it("lets a caller override a default", () => {
		// `{ ...defaults, ...options }` — the caller wins. Defaults that could
		// not be overridden would make the option block decorative.
		expect(lakebed.with.capsule({ coldStart: "warm" }).options.coldStart).toBe(
			"warm",
		);
		expect(
			lakebed.with.files({ publicAccess: true }).options.publicAccess,
		).toBe(true);
	});

	it("lets a caller add a key the defaults do not name", () => {
		expect(lakebed.with.capsule({ memoryMb: 512 }).options.memoryMb).toBe(512);
	});

	it("gives each call its own options object", () => {
		// Fresh spread per call, so a caller mutating one block's options cannot
		// change what a later call defaults to.
		const first = lakebed.with.capsule();
		first.options.coldStart = "mutated";
		expect(lakebed.with.capsule().options.coldStart).toBe("instant");
	});

	it("routes each block to the port it configures", () => {
		expect(lakebed.with.capsule().port).toBe("compute");
		expect(lakebed.with.reactiveDb().port).toBe("database");
		expect(lakebed.with.files().port).toBe("objectStore");
	});
});
