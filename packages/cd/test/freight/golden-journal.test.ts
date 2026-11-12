// Golden v1 event bodies for every Freight fact (append-only corpus): a
// journal written by this release must fold identically in every later one.
// Changing a body shape needs an upcaster plus a new corpus entry, never an
// edit here.
import type { JsonObject } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { createFreightLedger } from "../../src/freight/index.js";
import { clock, fid, MapArtifactVerifier, MemoryEventStore, OPERATOR, RecordingTelemetry, TENANT } from "./fakes.js";

const ID = "sha256:ae0f98fdeeb128cba56de1013e09f0ee0f0e1939c05ab04da41293807b9c5a69";

const CORPUS: readonly Readonly<{ type: string; v: 1; data: JsonObject }>[] = [
	{
		type: CD_EVENTS.FreightRecorded,
		v: 1,
		data: {
			schemaVersion: "hobo.cd.freight/v1",
			freightId: ID,
			alias: "juicy-geyser",
			manifest: {
				schemaVersion: "hobo.freight-manifest/v1",
				bindle: "shop",
				declarationHash: "sha256:e77d7f3dc257d83b08015aa3dfff96a3539291d11e63129fc16a4d0669c33fca",
				artifacts: [
					{
						name: "api",
						kind: "ARTIFACT_KIND_WASM_COMPONENT",
						digest: "sha256:14c2529eb4498c5d1ffd6915d05bf58a91bdda796af59f41d480d11c099d0479",
						coordinate: "store://api",
						sizeBytes: "1024",
					},
				],
				labels: { team: "storefront" },
				subject: "FREIGHT_SUBJECT_BINDLE",
			},
			origin: "FREIGHT_ORIGIN_MANIFEST",
			recordedBy: "user:ops@acme",
			recordedAt: "2026-11-12T12:00:00.000Z",
		},
	},
	{
		type: CD_EVENTS.FreightQualified,
		v: 1,
		data: {
			freightId: ID,
			campId: "staging",
			pipeline: "shop",
			node: "staging",
			verificationId: "ver-1",
			qualifiedAt: "2026-11-12T13:00:00.000Z",
		},
	},
	{
		type: CD_EVENTS.FreightApproved,
		v: 1,
		data: {
			freightId: ID,
			campId: "prod-eu",
			approvedBy: "user:lead@acme",
			reason: "hotfix INC-12",
			decisionId: "dec-9",
			approvedAt: "2026-11-12T13:30:00.000Z",
			expiresAt: "2026-11-13T13:30:00.000Z",
		},
	},
	{
		type: CD_EVENTS.FreightYanked,
		v: 1,
		data: { freightId: ID, reason: "CVE-2026-0001", yankedBy: "user:sec@acme", yankedAt: "2026-11-12T14:00:00.000Z" },
	},
	{
		type: CD_EVENTS.FreightRetired,
		v: 1,
		data: { freightId: ID, reason: "retention", retiredAt: "2026-12-12T14:00:00.000Z" },
	},
];

describe("golden Freight journal corpus (v1 bodies)", () => {
	it("folds every v1 body into the same ledger state", async () => {
		const store = new MemoryEventStore();
		await store.append(
			CD_STREAMS.freight(ID),
			CORPUS.map((entry) => ({ type: entry.type, v: entry.v, data: entry.data })),
			{ expectedSeq: 0, actor: OPERATOR, tenant: TENANT },
		);
		const time = clock();
		const ledger = createFreightLedger({ store, tenant: TENANT, now: time.now, artifacts: new MapArtifactVerifier(), telemetry: new RecordingTelemetry() });
		const id = fid(ID);
		const record = await ledger.get(id);
		expect(record?.alias).toBe("juicy-geyser");
		expect(record?.manifest?.artifacts[0]?.sizeBytes).toBe(1024n);
		expect(await ledger.getByAlias("juicy-geyser")).toEqual(record);
		expect((await ledger.qualifications(id)).map((q) => [q.campId, q.verificationId])).toEqual([["staging", "ver-1"]]);
		expect((await ledger.approvals(id)).map((a) => [a.campId, a.decisionId, a.expiresAt])).toEqual([
			["prod-eu", "dec-9", "2026-11-13T13:30:00.000Z"],
		]);
		expect(await ledger.isUsable(id)).toBe(false);
	});

	it("tolerates unknown fields added by a later minor version", async () => {
		const store = new MemoryEventStore();
		const first = CORPUS[0];
		if (!first) throw new Error("corpus empty");
		await store.append(CD_STREAMS.freight(ID), [{ type: first.type, data: { ...first.data, addedLater: true } }], {
			expectedSeq: 0,
			actor: OPERATOR,
			tenant: TENANT,
		});
		const time = clock();
		const ledger = createFreightLedger({ store, tenant: TENANT, now: time.now, artifacts: new MapArtifactVerifier(), telemetry: new RecordingTelemetry() });
		expect(await ledger.isUsable(fid(ID))).toBe(true);
	});

	it("an unreadable body makes the Freight unusable (fail closed)", async () => {
		const store = new MemoryEventStore();
		const first = CORPUS[0];
		if (!first) throw new Error("corpus empty");
		await store.append(
			CD_STREAMS.freight(ID),
			[
				{ type: first.type, data: first.data },
				{ type: CD_EVENTS.FreightYanked, data: "corrupt" },
			],
			{ expectedSeq: 0, actor: OPERATOR, tenant: TENANT },
		);
		const time = clock();
		const ledger = createFreightLedger({ store, tenant: TENANT, now: time.now, artifacts: new MapArtifactVerifier(), telemetry: new RecordingTelemetry() });
		expect(await ledger.isUsable(fid(ID))).toBe(false);
	});
});
