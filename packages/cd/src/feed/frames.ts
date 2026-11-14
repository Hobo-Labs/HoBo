// DeliveryFeedFrame construction (D5, D25). The frame carries the Set, the
// Camp's management mode (OBSERVE_ONLY from either the spec or the declared
// topology wins), the posture observe_fields, the policy binding, and the
// canonical resolved set inline when its blob is ≤ 256 KiB and verifies
// against its digest; otherwise only the digest, and the agent fetches
// `GET /v1/cd/blobs/{digest}` (which refuses a missing or corrupt blob).
import { createHash } from "node:crypto";
import { create, toJson } from "@bufbuild/protobuf";
import {
	CampManagement,
	type DeliveryFeedFrame,
	DeliveryFeedFrameSchema,
} from "../_generated/cd_pb.js";
import { FEED_INLINE_LIMIT_BYTES } from "../events.js";
import type {
	ArtifactStore,
	CampId,
	DesiredStateChange,
	Digest,
	PostureService,
	TopologyReader,
} from "../ports.js";

export type FrameSources = Readonly<{
	artifacts: ArtifactStore;
	posture: PostureService;
	topology: TopologyReader;
}>;

export function digestOf(bytes: Uint8Array): Digest {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function verifiedBlob(
	artifacts: ArtifactStore,
	digest: string,
): Promise<"missing" | "corrupt" | Uint8Array> {
	if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return "missing";
	// SAFETY: the pattern above proves the digest form.
	const bytes = await artifacts.get(digest as Digest);
	if (!bytes) return "missing";
	return digestOf(bytes) === digest ? bytes : "corrupt";
}

export async function buildFrame(
	change: DesiredStateChange,
	campId: CampId,
	sources: FrameSources,
): Promise<DeliveryFeedFrame> {
	const topology = await sources.topology.camp(campId);
	const management =
		topology?.management === CampManagement.OBSERVE_ONLY ||
		change.management === CampManagement.OBSERVE_ONLY
			? CampManagement.OBSERVE_ONLY
			: change.management === CampManagement.UNSPECIFIED
				? CampManagement.MANAGED
				: change.management;
	const observeFields = [...(await sources.posture.observeFields(campId))];
	let resolvedSetJson = "";
	if (
		change.set.resolvedSetBytes > 0n &&
		change.set.resolvedSetBytes <= BigInt(FEED_INLINE_LIMIT_BYTES)
	) {
		const blob = await verifiedBlob(
			sources.artifacts,
			change.set.resolvedSetDigest,
		);
		if (
			blob instanceof Uint8Array &&
			blob.byteLength <= FEED_INLINE_LIMIT_BYTES
		)
			resolvedSetJson = new TextDecoder().decode(blob);
	}
	const frame = create(DeliveryFeedFrameSchema, {
		position: change.position.toString(10),
		set: change.set,
		resolvedSetJson,
		observeFields,
		management,
	});
	if (change.policy) frame.policy = change.policy;
	return frame;
}

export function frameJson(frame: DeliveryFeedFrame): string {
	return JSON.stringify(toJson(DeliveryFeedFrameSchema, frame));
}
