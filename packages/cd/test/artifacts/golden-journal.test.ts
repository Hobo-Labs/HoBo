// Golden v1 bodies for artifact.Stored / artifact.Deleted (append-only
// corpus): a journal written by this release must decode identically in every
// later one, and today's writer must still produce exactly these bodies.
// Changing a body shape needs an upcaster plus a new corpus entry, never an
// edit here.
import { toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ArtifactDeletedRecordSchema,
	ArtifactKind,
	ArtifactStoredRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createArtifactStore } from "../../src/artifacts/index.js";
import { createArtifactJournal } from "../../src/artifacts/journal.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type { Digest } from "../../src/ports.js";
import {
	bytesOf,
	context,
	MemoryEventStore,
	OPERATOR,
	T0,
	TENANT,
} from "./fakes.js";

// sha256("golden artifact bytes")
const DIGEST =
	"sha256:e70c8305e9ab0c29902eb6fb5b3ab4643ebb265bb0d1820979971d9ef19e7ec4";

const CORPUS = [
	{
		type: CD_EVENTS.ArtifactStored,
		v: 1,
		data: {
			artifact: {
				name: "api.wasm",
				kind: "ARTIFACT_KIND_WASM_COMPONENT",
				digest: DIGEST,
				coordinate: `store://filesystem/${DIGEST}`,
				sizeBytes: "21",
				mediaType: "application/wasm",
				ecosystem: "store",
			},
			backend: "filesystem",
			storedAt: "2026-11-12T12:00:00.000Z",
		},
	},
	{
		type: CD_EVENTS.ArtifactDeleted,
		v: 1,
		data: {
			digest: DIGEST,
			backend: "filesystem",
			reason: "retention: unreferenced past blob grace",
			deletedAt: "2026-11-19T12:00:00.000Z",
		},
	},
] as const;

describe("artifact journal golden corpus (v1)", () => {
	it("decodes every corpus body to the record it was written from", async () => {
		const store = new MemoryEventStore();
		const streamId = CD_STREAMS.artifact(DIGEST);
		for (const [index, entry] of CORPUS.entries())
			await store.append(
				streamId,
				[{ type: entry.type, v: entry.v, data: structuredClone(entry.data) }],
				{ expectedSeq: index, actor: OPERATOR, tenant: TENANT },
			);
		const history = await createArtifactJournal(
			{ store, tenant: TENANT, now: () => T0 },
			"filesystem",
		).history(DIGEST as Digest);
		expect(history).toHaveLength(2);
		expect(toJson(ArtifactStoredRecordSchema, history[0] as never)).toEqual(
			CORPUS[0].data,
		);
		expect(toJson(ArtifactDeletedRecordSchema, history[1] as never)).toEqual(
			CORPUS[1].data,
		);
	});

	it("today's writer still emits the corpus body shape", async () => {
		const events = new MemoryEventStore();
		const store = createArtifactStore(
			{ backend: "memory" },
			{ store: events, tenant: TENANT, now: () => T0 },
		);
		const ref = await store.put(
			bytesOf("golden artifact bytes"),
			{
				name: "api.wasm",
				kind: ArtifactKind.WASM_COMPONENT,
				mediaType: "application/wasm",
			},
			context(),
		);
		const [stored] = events.events(CD_STREAMS.artifact(ref.digest));
		expect(stored?.type).toBe(CD_EVENTS.ArtifactStored);
		expect(stored?.v).toBe(1);
		expect(Object.keys(stored?.data ?? {}).sort()).toEqual(
			Object.keys(CORPUS[0].data).sort(),
		);
		expect(
			Object.keys((stored?.data as { artifact: object }).artifact).sort(),
		).toEqual(Object.keys(CORPUS[0].data.artifact).sort());
	});
});
