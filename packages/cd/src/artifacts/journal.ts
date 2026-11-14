// `artifact.Stored` / `artifact.Deleted` on `cd-artifact-<digest>`. The stream
// head says whether the journal believes a blob is present; appends are
// expected-version and idempotency-keyed, so concurrent puts of one digest
// record it once and a retried delete records it once.
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import type { EventEnvelope, PrincipalRef } from "@hobo/core";
import {
	type ArtifactDeletedRecord,
	ArtifactDeletedRecordSchema,
	type ArtifactRef,
	type ArtifactStoredRecord,
	ArtifactStoredRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../events.js";
import type { CdBase, CdContext, Digest } from "../ports.js";
import { isJsonObject, type JsonValue, jsonOf } from "./json.js";
import { ARTIFACT_REASON, ArtifactStoreError } from "./reasons.js";

type Head = Readonly<{ seq: number; type: string | undefined }>;

async function head(store: CdBase["store"], streamId: string): Promise<Head> {
	let seq = 0;
	let type: string | undefined;
	for await (const event of store.read(streamId)) {
		seq = event.seq;
		type = event.type;
	}
	return { seq, type };
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export type ArtifactJournal = Readonly<{
	recordStored(artifact: ArtifactRef, ctx: CdContext): Promise<boolean>;
	recordDeleted(
		digest: Digest,
		reason: string,
		ctx: CdContext,
	): Promise<boolean>;
	history(
		digest: Digest,
	): Promise<readonly (ArtifactStoredRecord | ArtifactDeletedRecord)[]>;
}>;

export function createArtifactJournal(
	d: CdBase,
	backend: string,
): ArtifactJournal {
	async function append(
		digest: Digest,
		type: string,
		want: (current: Head) => boolean,
		data: JsonValue,
		principal: PrincipalRef,
	): Promise<boolean> {
		const streamId = CD_STREAMS.artifact(digest);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const current = await head(d.store, streamId);
			if (!want(current)) return false;
			try {
				const result = await d.store.append(
					streamId,
					[
						{
							type,
							v: 1,
							data,
							meta: { idempotencyKey: `${type}:${digest}:${current.seq + 1}` },
						},
					],
					{ expectedSeq: current.seq, actor: principal, tenant: d.tenant },
				);
				return result.appended.length > 0;
			} catch {
				// Another writer moved the head; re-read and decide again.
			}
		}
		throw new ArtifactStoreError(
			ARTIFACT_REASON.journalConflict,
			`could not record ${type} for ${digest} after concurrent writers moved its stream`,
			"Retry the operation; it is idempotent by digest. Persistent conflicts mean two stores share one journal with different backends.",
			digest,
		);
	}

	return {
		recordStored(artifact, ctx) {
			// SAFETY: the store only journals digests it computed itself.
			const digest = artifact.digest as Digest;
			const record = create(ArtifactStoredRecordSchema, {
				artifact,
				backend,
				storedAt: iso(ctx.now()),
			});
			return append(
				digest,
				CD_EVENTS.ArtifactStored,
				(current) => current.type !== CD_EVENTS.ArtifactStored,
				toJson(ArtifactStoredRecordSchema, record),
				ctx.principal,
			);
		},
		recordDeleted(digest, reason, ctx) {
			const record = create(ArtifactDeletedRecordSchema, {
				digest,
				backend,
				reason,
				deletedAt: iso(ctx.now()),
			});
			return append(
				digest,
				CD_EVENTS.ArtifactDeleted,
				(current) => current.type === CD_EVENTS.ArtifactStored,
				toJson(ArtifactDeletedRecordSchema, record),
				ctx.principal,
			);
		},
		async history(digest) {
			const records: (ArtifactStoredRecord | ArtifactDeletedRecord)[] = [];
			for await (const event of d.store.read(CD_STREAMS.artifact(digest))) {
				const decoded = decodeEvent(event);
				if (decoded !== undefined) records.push(decoded);
			}
			return records;
		},
	};
}

function decodeEvent(
	event: EventEnvelope,
): ArtifactStoredRecord | ArtifactDeletedRecord | undefined {
	const data = jsonOf(event.data);
	if (!isJsonObject(data)) return undefined;
	try {
		if (event.type === CD_EVENTS.ArtifactStored)
			return fromJson(ArtifactStoredRecordSchema, data, {
				ignoreUnknownFields: true,
			});
		if (event.type === CD_EVENTS.ArtifactDeleted)
			return fromJson(ArtifactDeletedRecordSchema, data, {
				ignoreUnknownFields: true,
			});
	} catch {
		return undefined;
	}
	return undefined;
}
