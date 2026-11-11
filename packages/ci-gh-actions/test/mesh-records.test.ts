import { readFileSync } from "node:fs";
import {
	assessMeshTrust,
	generateMeshIdentity,
	type MeshNode,
	meshNodeReport,
	signMeshAdvert,
	verifyMeshAdvert,
} from "@hobo/ci/mesh";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	meshAdvertJson,
	meshFleetStateJson,
	meshNodeReportsJson,
	meshNodeReportsMessage,
	meshReliabilityRecordJson,
	meshTrustConfigJson,
	parseMeshAdvert,
	parseMeshNodeReports,
	parseMeshReliabilityRecord,
	parseMeshTrustConfig,
} from "../src/mesh-records.js";

const NOW = Date.parse("2026-11-10T02:40:05.000Z");
const fixture = (name: string) =>
	readFileSync(
		new URL(`../data-models/fixtures/${name}`, import.meta.url),
		"utf8",
	);

const node = (overrides: Partial<MeshNode> = {}): MeshNode => ({
	id: "box-a",
	freeSlots: 2,
	totalSlots: 4,
	healthy: true,
	labels: ["hobo", "hobo-trunk"],
	validUntilMs: NOW + 45_000,
	free: { memoryMb: 12_288, diskMb: 204_800 },
	platform: { os: "linux", arch: "x64" },
	reliability: 0.875,
	samples: { delivered: 10, dropped: 2 },
	sinceMs: NOW - 60_000,
	...overrides,
});

/**
 * The advertisement as every version before this one read it: the schema the
 * board used until the record became protobuf. A node still running it must
 * go on reading what a newer node writes.
 */
const AdvertBeforeSigning = z.object({
	id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	freeSlots: z.number().int().min(0).max(4096),
	totalSlots: z.number().int().min(0).max(4096).optional(),
	healthy: z.boolean(),
	labels: z.array(z.string().min(1).max(80)).max(32),
	validUntilMs: z.number().int().nonnegative(),
	free: z
		.object({
			memoryMb: z.number().int().min(0).max(16_777_216).optional(),
			diskMb: z.number().int().min(0).max(1_073_741_824).optional(),
		})
		.optional(),
	platform: z
		.object({
			os: z.string().min(1).max(32),
			arch: z.string().min(1).max(32),
		})
		.optional(),
	reliability: z.number().min(0).max(1).optional(),
});

describe("the advertisement record", () => {
	it("round-trips a signed advertisement with its signature intact", () => {
		const { identity } = generateMeshIdentity();
		const signed = signMeshAdvert(node(), identity);
		const read = parseMeshAdvert(meshAdvertJson(signed));
		expect(read).toEqual(signed);
		expect(read && verifyMeshAdvert(read)).toBe("valid");
	});

	it("reads the checked-in fixture, whose signature still verifies", () => {
		const read = parseMeshAdvert(fixture("valid/mesh-advert.json"));
		expect(read).toMatchObject({
			id: "box-a",
			free: { memoryMb: 12_288, diskMb: 204_800 },
			samples: { delivered: 10, dropped: 2 },
		});
		expect(read && verifyMeshAdvert(read)).toBe("valid");
	});

	it("reads an older node's advertisement, which is then unverified", () => {
		const read = parseMeshAdvert(fixture("valid/mesh-advert-older-node.json"));
		expect(read).toEqual({
			id: "box-old",
			freeSlots: 0,
			healthy: false,
			labels: ["hobo"],
			validUntilMs: 1_794_268_845_000,
			totalSlots: undefined,
			free: undefined,
			platform: undefined,
			reliability: undefined,
			samples: undefined,
			sinceMs: undefined,
			identity: undefined,
		});
		if (!read) throw new Error("the older advertisement was not read");
		expect(verifyMeshAdvert(read)).toBe("unsigned");
		expect(
			assessMeshTrust(read, {
				trustedKeys: [{ publicKey: generateMeshIdentity().identity.publicKey }],
				requireTrusted: false,
			}),
		).toBe("unverified");
		expect(meshNodeReport(read, 0)).toMatchObject({
			trust: "unverified",
			state: "unhealthy",
		});
		// Exactly what a node on the version before memory and platform sent.
		expect(
			parseMeshAdvert(
				'{"id":"box-b","freeSlots":5,"healthy":true,"labels":["hobo"],"validUntilMs":1794268845000}',
			),
		).toMatchObject({ id: "box-b", freeSlots: 5, healthy: true });
	});

	it("writes what a node on the previous version still reads", () => {
		const { identity } = generateMeshIdentity();
		for (const each of [
			signMeshAdvert(node(), identity),
			// Zeros and an empty list are written out, not left to be defaults.
			signMeshAdvert(
				{
					id: "relay-host",
					freeSlots: 0,
					totalSlots: 0,
					healthy: false,
					labels: [],
					validUntilMs: NOW,
				},
				identity,
			),
		]) {
			const written: unknown = JSON.parse(meshAdvertJson(each));
			expect(written).toMatchObject({
				freeSlots: each.freeSlots,
				healthy: each.healthy,
				labels: each.labels,
			});
			const old = AdvertBeforeSigning.parse(written);
			expect(old.id).toBe(each.id);
			expect(old.validUntilMs).toBe(each.validUntilMs);
			expect(old.free).toEqual(each.free);
		}
	});

	it("keeps an absent figure absent: unknown is not zero", () => {
		const written = meshAdvertJson({
			id: "box-a",
			freeSlots: 1,
			healthy: true,
			labels: ["hobo"],
			validUntilMs: NOW,
			free: { memoryMb: 0 },
		});
		expect(JSON.parse(written)).toEqual({
			id: "box-a",
			freeSlots: 1,
			healthy: true,
			labels: ["hobo"],
			validUntilMs: NOW,
			free: { memoryMb: 0 },
		});
		expect(parseMeshAdvert(written)?.free).toEqual({
			memoryMb: 0,
			diskMb: undefined,
		});
	});

	it("never writes or reads what only a reader computes", () => {
		const written = meshAdvertJson(node({ trust: "trusted", seenAtMs: NOW }));
		expect(written).not.toContain("trust");
		expect(written).not.toContain("seenAtMs");
		// A node that states its own trust is read without it.
		const read = parseMeshAdvert(
			fixture("invalid/mesh-advert-states-its-own-trust.json"),
		);
		expect(read?.id).toBe("box-a");
		expect(read?.trust).toBeUndefined();
	});

	it("ignores a field a newer version added and refuses what it cannot rank", () => {
		expect(
			parseMeshAdvert(
				'{"id":"box-a","freeSlots":1,"healthy":true,"labels":["hobo"],"validUntilMs":5,"gpus":2}',
			)?.id,
		).toBe("box-a");
		for (const unreadable of [
			"not json",
			"[]",
			'{"id":"bad id","freeSlots":1,"healthy":true,"labels":[],"validUntilMs":5}',
			'{"id":"box-a","freeSlots":-1,"healthy":true,"labels":[],"validUntilMs":5}',
			'{"id":"box-a","freeSlots":9999,"healthy":true,"labels":[],"validUntilMs":5}',
			'{"id":"box-a","freeSlots":1.5,"healthy":true,"labels":[],"validUntilMs":5}',
			'{"id":"box-a","freeSlots":1,"healthy":"yes","labels":[],"validUntilMs":5}',
			'{"id":"box-a","freeSlots":1,"healthy":true,"labels":[""],"validUntilMs":5}',
			'{"id":"box-a","freeSlots":1,"healthy":true,"labels":[],"validUntilMs":5.5}',
			'{"id":"box-a","freeSlots":1,"healthy":true,"labels":[],"validUntilMs":5,"reliability":2}',
			'{"id":"box-a","freeSlots":1,"healthy":true,"labels":[],"validUntilMs":5,"platform":{"os":"","arch":"x64"}}',
			'{"id":"box-a","freeSlots":1,"healthy":true,"labels":[],"validUntilMs":5,"samples":{"delivered":-1,"dropped":0}}',
		])
			expect(parseMeshAdvert(unreadable), unreadable).toBeUndefined();
	});

	it("keeps an advertisement with a bad signature, so the reader can report it", () => {
		const read = parseMeshAdvert(
			'{"id":"box-a","freeSlots":1,"healthy":true,"labels":[],"validUntilMs":5,"identity":{"publicKey":"nope","signature":"nope"}}',
		);
		expect(read?.identity).toEqual({ publicKey: "nope", signature: "nope" });
		expect(read && verifyMeshAdvert(read)).toBe("invalid");
	});

	it("refuses to write an advertisement no reader would accept", () => {
		for (const bad of [
			node({ id: "bad id" }),
			node({ freeSlots: -1 }),
			node({ labels: Array.from({ length: 33 }, (_, index) => `l${index}`) }),
			node({ reliability: 1.5 }),
			node({ free: { diskMb: 2_000_000_000 } }),
		])
			expect(() => meshAdvertJson(bad)).toThrow(/^invalid mesh /);
	});
});

describe("the trust settings record", () => {
	const key = generateMeshIdentity().identity.publicKey;
	const other = generateMeshIdentity().identity.publicKey;

	it("round-trips keys, their node bindings and the requirement", () => {
		const policy = {
			trustedKeys: [{ publicKey: key, nodeId: "box-a" }, { publicKey: other }],
			requireTrusted: true,
		};
		expect(parseMeshTrustConfig(meshTrustConfigJson(policy))).toEqual(policy);
		expect(
			parseMeshTrustConfig(fixture("valid/mesh-trust-config.json")),
		).toMatchObject({ requireTrusted: true });
	});

	it("reads unusable settings as nothing, and refuses to write them", () => {
		for (const unusable of [
			"not json",
			'{"trustedKeys":[{"publicKey":"too-short"}]}',
			`{"trustedKeys":[{"publicKey":"${key}","nodeId":"bad id"}]}`,
			`{"trustedKeys":[{"publicKey":"${key}"}],"allowEveryone":true}`,
		])
			expect(parseMeshTrustConfig(unusable), unusable).toBeUndefined();
		expect(() =>
			meshTrustConfigJson({
				trustedKeys: [{ publicKey: "short" }],
				requireTrusted: false,
			}),
		).toThrow("invalid mesh public key");
	});
});

describe("the reliability record", () => {
	it("round-trips, and reads a damaged record as no record", () => {
		const record = { delivered: 9.5, dropped: 0.25, atMs: NOW };
		expect(
			parseMeshReliabilityRecord(meshReliabilityRecordJson(record)),
		).toEqual(record);
		expect(
			parseMeshReliabilityRecord(fixture("valid/mesh-reliability-record.json")),
		).toEqual({ delivered: 9.5, dropped: 0.25, atMs: 1_794_268_000_000 });
		// Zeros survive the trip: a clean record is a record.
		expect(
			parseMeshReliabilityRecord(
				meshReliabilityRecordJson({ delivered: 0, dropped: 0, atMs: 0 }),
			),
		).toEqual({ delivered: 0, dropped: 0, atMs: 0 });
		for (const damaged of ["", "{", '{"delivered":-1,"dropped":0,"atMs":1}'])
			expect(parseMeshReliabilityRecord(damaged)).toBeUndefined();
	});
});

describe("the report every surface answers with", () => {
	it("says a host with no mesh has none, with no nodes and no reading time", () => {
		expect(
			JSON.parse(
				meshNodeReportsJson(
					meshNodeReportsMessage({ mesh: "not-configured", nowMs: NOW }),
				),
			),
		).toEqual({
			mesh: "not-configured",
			nodes: [],
			readAt: "",
			requireTrusted: false,
		});
		expect(
			parseMeshNodeReports(
				fixture("valid/mesh-node-reports-not-configured.json"),
			).mesh,
		).toBe("not-configured");
	});

	it("carries each node's availability, capacity, trust and reliability", () => {
		const live = meshNodeReport(
			node({
				trust: "trusted",
				seenAtMs: NOW - 2_000,
				identity: { publicKey: "K".repeat(43), signature: "S".repeat(86) },
			}),
			NOW,
		);
		const lost = meshNodeReport(
			{
				id: "relay-host",
				freeSlots: 0,
				totalSlots: 0,
				healthy: true,
				labels: [],
				validUntilMs: NOW - 65_000,
			},
			NOW,
		);
		const written = meshNodeReportsJson(
			meshNodeReportsMessage({
				mesh: "configured",
				view: {
					nodes: [live, lost],
					capacity: {
						nodes: 1,
						healthy: 1,
						available: 1,
						totalSlots: 4,
						freeSlots: 2,
						freeMemoryMb: 12_288,
						largestFreeMemoryMb: 12_288,
						freeDiskMb: 204_800,
					},
				},
				nowMs: NOW,
				requireTrusted: true,
			}),
		);
		expect(JSON.parse(written)).toEqual({
			mesh: "configured",
			nodes: [
				{
					id: "box-a",
					state: "live",
					since: "2026-11-10T02:39:05.000Z",
					healthy: true,
					lastSeenAt: "2026-11-10T02:40:03.000Z",
					validUntil: "2026-11-10T02:40:50.000Z",
					totalSlots: 4,
					freeSlots: 2,
					freeMemoryMb: 12_288,
					freeDiskMb: 204_800,
					platform: { os: "linux", arch: "x64" },
					labels: ["hobo", "hobo-trunk"],
					trust: "trusted",
					publicKey: "K".repeat(43),
					reliability: 0.875,
					delivered: 10,
					dropped: 2,
				},
				{
					id: "relay-host",
					state: "lost",
					since: "2026-11-10T02:39:00.000Z",
					healthy: true,
					// Unknown stays unknown: no time, no memory, no disk, no score.
					lastSeenAt: "",
					validUntil: "2026-11-10T02:39:00.000Z",
					totalSlots: 0,
					freeSlots: 0,
					labels: [],
					trust: "unverified",
					publicKey: "",
				},
			],
			capacity: {
				nodes: 1,
				healthy: 1,
				available: 1,
				totalSlots: 4,
				freeSlots: 2,
				freeMemoryMb: 12_288,
				largestFreeMemoryMb: 12_288,
				freeDiskMb: 204_800,
			},
			readAt: "2026-11-10T02:40:05.000Z",
			requireTrusted: true,
		});
		expect(parseMeshNodeReports(written).nodes[1]?.freeMemoryMb).toBe(
			undefined,
		);
		expect(
			parseMeshNodeReports(fixture("valid/mesh-node-reports.json")).nodes,
		).toHaveLength(2);
	});
});

describe("the routing snapshot", () => {
	it("is small, ordered, and names labels and counts only", () => {
		const written = meshFleetStateJson(
			new Map([
				["hobo-trunk", { nodes: 0, trustedNodes: 0, freeSlots: 0 }],
				["hobo", { nodes: 2, trustedNodes: 1, freeSlots: 3 }],
			]),
			NOW,
		);
		expect(written).toBe(
			'{"publishedAt":"2026-11-10T02:40:05.000Z","labels":{"hobo":{"nodes":2,"trustedNodes":1,"freeSlots":3},"hobo-trunk":{"nodes":0,"trustedNodes":0,"freeSlots":0}}}',
		);
		// The checked-in fixture is this same shape.
		expect(JSON.parse(fixture("valid/mesh-fleet-state.json"))).toEqual(
			JSON.parse(written),
		);
	});
});
